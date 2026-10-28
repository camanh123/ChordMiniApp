"""Bounded Firebase offload admission. Network streams and audio fixtures are local."""

from __future__ import annotations

import ast
import http.server
import io
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import urllib.parse
import wave
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    import flask  # noqa: F401
except ModuleNotFoundError:
    flask = types.ModuleType("flask")
    flask.current_app = types.SimpleNamespace()
    flask.jsonify = lambda payload=None, **_kwargs: payload
    flask.request = types.SimpleNamespace(form={}, files={})
    sys.modules["flask"] = flask

from security.inference_guard import DEFAULT_UPLOAD_MB, sniff_audio
import security.offload_audio as offload_audio
from security.offload_audio import (
    MAX_OFFLOAD_BYTES,
    TOTAL_TIMEOUT_SECONDS,
    OffloadRejected,
    RemoteResponse,
    _measure_mp3,
    choose_detector,
    default_transport,
    download_offload_to_path,
    execute_offload,
)


SIGNED_URL = (
    "https://firebasestorage.googleapis.com/v0/b/demo/o/song.wav"
    "?alt=media&token=signed-token-value"
)
PUBLIC_IP = "8.8.8.8"


def wav_bytes(frames: int, rate: int = 8000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()


def mp3_frame() -> bytes:
    # MPEG1 Layer III, 128 kbps, 44100 Hz, no padding. Frame length is 417 bytes.
    return bytes((0xFF, 0xFB, 0x90, 0x00)) + (b"\x00" * 413)


class ScriptedResponse:
    def __init__(self, status=200, headers=None, chunks=None, fail=None):
        self.status = status
        self.headers = headers or {}
        self._chunks = list(chunks or [])
        self._fail = fail
        self.reads = 0
        self.closed = False

    def read(self, _amount: int) -> bytes:
        self.reads += 1
        if self._fail is not None and self.reads >= self._fail[0]:
            raise self._fail[1]
        if not self._chunks:
            return b""
        return self._chunks.pop(0)

    def close(self) -> None:
        self.closed = True


def scripted_transport(response: ScriptedResponse):
    calls = []

    def transport(parts, ip, timeout):
        calls.append((parts.hostname, ip, timeout, parts.query))
        return RemoteResponse(response.status, response.headers, response.read, response.close)

    return transport, calls


def run_offload(payload, response, infer, available=("madmom", "beat-transformer", "librosa"), requested="auto", family="beat", resolve=None, clock=None):
    if isinstance(payload, (bytes, bytearray)):
        chunks = [payload]
    else:
        chunks = payload
    body = response if isinstance(response, ScriptedResponse) else ScriptedResponse(chunks=chunks, headers=getattr(response, "headers", None))
    if not isinstance(response, ScriptedResponse):
        body = ScriptedResponse(chunks=chunks)
    transport, calls = scripted_transport(body)
    seen = {}

    def wrapped(path, detector):
        seen["path"] = path
        seen["exists"] = os.path.exists(path)
        seen["suffix"] = os.path.splitext(path)[1]
        seen["detector"] = detector
        return infer(path, detector)

    result = execute_offload(
        SIGNED_URL,
        family=family,
        requested=requested,
        available=available,
        infer=wrapped,
        transport=transport,
        resolve=resolve or (lambda _host: [PUBLIC_IP]),
        clock=clock,
    )
    return result, seen, body, calls


class _QuietHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


class _LocalTlsFixture:
    def start(self):
        self.directory = tempfile.mkdtemp(prefix="offload_tls_")
        cert = os.path.join(self.directory, "cert.pem")
        key = os.path.join(self.directory, "key.pem")
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", key, "-out", cert, "-days", "1", "-nodes",
                "-subj", "/CN=offload.fixture.invalid",
                "-addext", "subjectAltName=DNS:offload.fixture.invalid",
            ],
            check=True,
            capture_output=True,
        )
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _QuietHandler)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(cert, key)
        self.httpd.socket = server_context.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_context.check_hostname = True
        client_context.verify_mode = ssl.CERT_REQUIRED
        client_context.load_verify_locations(cert)
        self.client_context = client_context

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class OffloadLimitTests(unittest.TestCase):
    def test_valid_firebase_audio_is_measured_and_inferred(self):
        payload = wav_bytes(8, 8000)
        result, seen, body, _calls = run_offload(payload, None, lambda _path, detector: {"success": True, "detector": detector})
        self.assertTrue(result["success"])
        self.assertEqual(seen["detector"], "madmom")
        self.assertTrue(seen["exists"])
        self.assertEqual(seen["suffix"], ".bin")
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertTrue(body.closed)
        renamed = seen["path"] + ".mp3"
        with open(renamed, "wb") as handle:
            handle.write(payload)
        try:
            self.assertEqual(sniff_audio(renamed), "wav")
        finally:
            os.unlink(renamed)

    def test_missing_content_length_still_counts_bytes(self):
        payload = wav_bytes(4, 8000)
        body = ScriptedResponse(chunks=[payload[:10], payload[10:]], headers={})
        result, _seen, _body, _calls = run_offload(None, body, lambda _path, _detector: {"success": True})
        self.assertTrue(result["success"])

    def test_false_content_length_does_not_authorize_extra_bytes(self):
        payload = wav_bytes(4, 8000)
        small = ScriptedResponse(chunks=[payload], headers={"Content-Length": "4"})
        result, _seen, _body, _calls = run_offload(None, small, lambda _path, _detector: {"success": True})
        self.assertTrue(result["success"])

        huge = ScriptedResponse(chunks=[payload], headers={"Content-Length": str(MAX_OFFLOAD_BYTES + 1)})
        with self.assertRaises(OffloadRejected) as raised:
            run_offload(None, huge, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(raised.exception.code, "DOWNLOAD_TOO_LARGE")
        self.assertEqual(huge.reads, 0)
        self.assertNotIn("signed-token-value", str(raised.exception))

    def test_download_over_byte_limit_stops_midway(self):
        chunk = b"\x00" * (64 * 1024)
        produced = {"count": 0}

        class Endless(ScriptedResponse):
            def read(self, _amount):
                self.reads += 1
                produced["count"] += 1
                if produced["count"] > (MAX_OFFLOAD_BYTES // len(chunk)) + 5:
                    raise AssertionError("read past the byte cap")
                return chunk

        body = Endless(headers={"Content-Length": "16"})
        with self.assertRaises(OffloadRejected) as raised:
            run_offload(None, body, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(raised.exception.code, "DOWNLOAD_TOO_LARGE")
        self.assertLess(produced["count"], (MAX_OFFLOAD_BYTES // len(chunk)) + 5)
        self.assertTrue(body.closed)

    def test_timeout_and_interrupted_streams_do_not_infer(self):
        stalled = ScriptedResponse(chunks=[b"abc"], fail=(1, socket.timeout()))
        with self.assertRaises(OffloadRejected) as timed:
            run_offload(None, stalled, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(timed.exception.code, "DOWNLOAD_TIMEOUT")

        broken = ScriptedResponse(chunks=[b"abc", b"def"], fail=(2, ConnectionResetError("reset")))
        with self.assertRaises(OffloadRejected) as interrupted:
            run_offload(None, broken, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(interrupted.exception.code, "DOWNLOAD_INTERRUPTED")
        self.assertNotIn("signed-token-value", str(interrupted.exception))

        ticks = iter((0, 0, TOTAL_TIMEOUT_SECONDS + 1))
        deadline = ScriptedResponse(chunks=[wav_bytes(4, 8000)])
        with self.assertRaises(OffloadRejected) as overall:
            run_offload(
                None,
                deadline,
                lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")),
                clock=lambda: next(ticks),
            )
        self.assertEqual(overall.exception.code, "DOWNLOAD_TIMEOUT")
        self.assertEqual(deadline.reads, 0)

    def test_redirect_to_forbidden_host_is_not_followed(self):
        calls = []

        def transport(parts, ip, _timeout):
            calls.append((parts.hostname, ip))
            def close():
                return None
            return RemoteResponse(302, {"Location": "https://evil.example/file?token=signed-token-value"}, lambda _n: b"", close)

        fd, dest = tempfile.mkstemp(prefix="offload_redirect_")
        os.close(fd)
        try:
            with self.assertRaises(OffloadRejected) as raised:
                download_offload_to_path(
                    SIGNED_URL,
                    dest,
                    transport=transport,
                    resolve=lambda _host: [PUBLIC_IP],
                )
            self.assertEqual(raised.exception.code, "DESTINATION_FORBIDDEN")
            self.assertEqual(calls, [("firebasestorage.googleapis.com", PUBLIC_IP)])
            self.assertNotIn("signed-token-value", str(raised.exception))
            self.assertNotIn("token=", raised.exception.body()["error"])
        finally:
            if os.path.exists(dest):
                os.unlink(dest)

    def test_private_resolution_never_connects(self):
        def transport(_parts, _ip, _timeout):
            raise AssertionError("connected")

        fd, dest = tempfile.mkstemp(prefix="offload_private_")
        os.close(fd)
        try:
            for private in ("127.0.0.1", "10.1.2.3", "192.168.0.8", "169.254.169.254", "::1"):
                with self.assertRaises(OffloadRejected) as raised:
                    download_offload_to_path(
                        SIGNED_URL,
                        dest,
                        transport=transport,
                        resolve=lambda _host, private=private: [private],
                    )
                self.assertEqual(raised.exception.code, "DESTINATION_FORBIDDEN")
        finally:
            os.unlink(dest)

    def test_invalid_bytes_are_rejected_before_inference(self):
        body = ScriptedResponse(chunks=[b"not-audio-bytes!!"])
        with self.assertRaises(OffloadRejected) as raised:
            run_offload(None, body, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(raised.exception.code, "INVALID_AUDIO")
        self.assertTrue(body.closed)

    def test_duration_over_720_seconds_is_rejected(self):
        payload = wav_bytes(721, 1)
        with self.assertRaises(OffloadRejected) as raised:
            run_offload(payload, None, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(raised.exception.code, "DURATION_EXCEEDED")

    def test_duration_failure_and_zero_are_rejected(self):
        truncated = wav_bytes(8, 8000)[:-8]
        with self.assertRaises(OffloadRejected) as failed:
            run_offload(truncated, None, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(failed.exception.code, "DURATION_FAILED")

        silent = wav_bytes(0, 8000)
        with self.assertRaises(OffloadRejected) as invalid:
            run_offload(silent, None, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(invalid.exception.code, "DURATION_INVALID")

        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        try:
            with open(path, "wb") as handle:
                handle.write(mp3_frame() + mp3_frame())
            self.assertEqual(_measure_mp3(path, 0.01), float("inf"))
        finally:
            os.unlink(path)

    def test_no_detector_for_oversized_input_skips_inference(self):
        self.assertIsNone(choose_detector(
            "beat",
            "auto",
            501 * 1024 * 1024,
            ["madmom", "beat-transformer", "librosa"],
        ))
        self.assertIsNone(choose_detector("beat", "beat-transformer", 101 * 1024 * 1024, ["beat-transformer", "librosa"]))
        self.assertEqual(choose_detector("beat", "auto", 1024, ["librosa"]), "librosa")

        payload = wav_bytes(8, 8000)
        with patch.dict(offload_audio.CHORD_SIZE_LIMITS_MB, {"btc-sl": 0.0, "btc-pl": 0.0, "chord-cnn-lstm": 0.0}):
            with self.assertRaises(OffloadRejected) as raised:
                run_offload(
                    payload,
                    None,
                    lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")),
                    available=["btc-sl", "btc-pl", "chord-cnn-lstm"],
                    requested="auto",
                    family="chord",
                )
        self.assertEqual(raised.exception.code, "NO_ELIGIBLE_DETECTOR")

    def test_temporary_file_removed_after_success_and_failure(self):
        payload = wav_bytes(8, 8000)
        _result, seen, _body, _calls = run_offload(payload, None, lambda _path, _detector: {"success": True})
        self.assertFalse(os.path.exists(seen["path"]))

        with self.assertRaises(OffloadRejected):
            run_offload(
                b"not-audio-bytes!!",
                None,
                lambda _path, _detector: {"success": True},
            )
        paths = [name for name in os.listdir(tempfile.gettempdir()) if name.startswith("chordmini_offload_")]
        self.assertEqual(paths, [])

    def test_signed_url_is_absent_from_errors(self):
        def transport(_parts, _ip, _timeout):
            raise OffloadRejected(400, "DOWNLOAD_FAILED", "The audio download was rejected.")

        fd, dest = tempfile.mkstemp()
        os.close(fd)
        try:
            with self.assertRaises(OffloadRejected) as raised:
                download_offload_to_path(SIGNED_URL, dest, transport=transport, resolve=lambda _host: [PUBLIC_IP])
        finally:
            os.unlink(dest)
        self.assertNotIn("signed-token-value", str(raised.exception))
        self.assertNotIn("token=", raised.exception.body()["error"])
        self.assertNotIn("https://", raised.exception.body()["error"])

        payload = wav_bytes(8, 8000)
        result, _seen, _body, _calls = run_offload(
            payload,
            None,
            lambda _path, _detector: {"success": False, "error": SIGNED_URL, "traceback": "secret"},
        )
        self.assertNotIn("signed-token-value", result["error"])
        self.assertNotIn("traceback", result)

    def test_direct_route_source_cannot_bypass_admission(self):
        beats = os.path.join(ROOT, "blueprints", "beats", "routes.py")
        chords = os.path.join(ROOT, "blueprints", "chords", "routes.py")
        beat_validators = os.path.join(ROOT, "blueprints", "beats", "validators.py")
        chord_validators = os.path.join(ROOT, "blueprints", "chords", "validators.py")
        for path in (beats, chords):
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            ast.parse(text)
            self.assertNotIn("requests.get", text)
            self.assertIn("execute_offload(", text)
        beat_fn = _function_source(beats, "detect_beats_firebase")
        chord_fn = _function_source(chords, "recognize_chords_firebase")
        local_beat = _function_source(beats, "detect_beats")
        local_chord = _function_source(chords, "recognize_chords")
        self.assertIn("force=False", beat_fn)
        self.assertIn("force=False", chord_fn)
        self.assertNotIn("traceback", beat_fn)
        self.assertNotIn("traceback", chord_fn)
        self.assertIn("return handle_beat_upload()", local_beat)
        self.assertNotIn("execute_offload", local_beat)
        self.assertIn("return handle_chord_upload()", local_chord)
        with open(beat_validators, encoding="utf-8") as handle:
            self.assertIn("public_url_problem", handle.read())
        with open(chord_validators, encoding="utf-8") as handle:
            chord_validator_text = handle.read()
        self.assertIn("public_url_problem", chord_validator_text)
        self.assertNotIn("firebasestorage.googleapis.com' not in", chord_validator_text)

        def transport(_parts, _ip, _timeout):
            raise AssertionError("connected")

        fd, dest = tempfile.mkstemp()
        os.close(fd)
        try:
            with self.assertRaises(OffloadRejected) as raised:
                download_offload_to_path(
                    "https://evil.example/song.wav?token=signed-token-value",
                    dest,
                    transport=transport,
                    resolve=lambda _host: [PUBLIC_IP],
                )
            self.assertEqual(raised.exception.code, "DESTINATION_FORBIDDEN")
            self.assertNotIn("signed-token-value", str(raised.exception))
        finally:
            os.unlink(dest)

    def test_known_local_container_is_rejected_with_a_format_reason(self):
        payload = b"fLaC" + (b"\x00" * 24)
        with self.assertRaises(OffloadRejected) as raised:
            run_offload(payload, None, lambda _path, _detector: (_ for _ in ()).throw(AssertionError("inferred")))
        self.assertEqual(raised.exception.code, "UNSUPPORTED_OFFLOAD_FORMAT")
        self.assertIn("WAV", raised.exception.message)
        self.assertIn("MP3", raised.exception.message)
        self.assertIn("FLAC", raised.exception.message)
        self.assertNotIn("signed-token-value", raised.exception.message)

    def test_transport_errors_hide_the_signed_url(self):
        parts = urllib.parse.urlsplit(SIGNED_URL)
        with patch("socket.create_connection", side_effect=TimeoutError("https://example.test/a?token=signed-token-value")):
            with self.assertRaises(OffloadRejected) as raised:
                default_transport(parts, PUBLIC_IP, 1)
        self.assertEqual(raised.exception.code, "DOWNLOAD_TIMEOUT")
        self.assertNotIn("signed-token-value", str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)

    def test_pinned_connection_checks_certificate_hostname(self):
        fixture = _LocalTlsFixture()
        fixture.start()
        self.addCleanup(fixture.stop)
        pinned = offload_audio._PinnedHTTPSConnection(
            "offload.fixture.invalid",
            "127.0.0.1",
            5,
            port=fixture.port,
            context=fixture.client_context,
        )
        response = pinned.request("/clip")
        try:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"ok")
        finally:
            response.close()
            pinned.close()

        mismatched = offload_audio._PinnedHTTPSConnection(
            "other.fixture.invalid",
            "127.0.0.1",
            5,
            port=fixture.port,
            context=fixture.client_context,
        )
        with self.assertRaises(ssl.SSLError):
            mismatched.request("/clip?token=signed-token-value")
        self.assertIsNone(mismatched._conn.sock)

        untrusted = offload_audio._PinnedHTTPSConnection(
            "offload.fixture.invalid",
            "127.0.0.1",
            5,
            port=fixture.port,
        )
        with self.assertRaises(ssl.SSLError):
            untrusted.request("/clip")
        self.assertIsNone(untrusted._conn.sock)

    def test_local_audio_flow_is_unchanged(self):
        self.assertEqual(DEFAULT_UPLOAD_MB, 50)
        fd, path = tempfile.mkstemp(suffix=".ignored")
        os.close(fd)
        try:
            with open(path, "wb") as handle:
                handle.write(wav_bytes(8, 8000))
            self.assertEqual(sniff_audio(path), "wav")
        finally:
            os.unlink(path)
        beats = _function_source(os.path.join(ROOT, "blueprints", "beats", "routes.py"), "detect_beats")
        chords = _function_source(os.path.join(ROOT, "blueprints", "chords", "routes.py"), "recognize_chords")
        self.assertIn("handle_beat_upload()", beats)
        self.assertIn("handle_chord_upload()", chords)


def _function_source(path: str, name: str) -> str:
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    marker = f"def {name}("
    start = text.index(marker)
    next_def = text.find("\ndef ", start + len(marker))
    next_route = text.find("\n@", start + len(marker))
    candidates = [pos for pos in (next_def, next_route) if pos != -1]
    end = min(candidates) if candidates else len(text)
    return text[start:end]


if __name__ == "__main__":
    unittest.main()
