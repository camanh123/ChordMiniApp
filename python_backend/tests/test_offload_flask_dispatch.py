"""Dispatch the real Flask offload routes through the testing app."""

from __future__ import annotations

import io
import os
import sys
import unittest
import wave
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app_factory import create_app
from security.offload_audio import RemoteResponse


SIGNED_URL = (
    "https://firebasestorage.googleapis.com/v0/b/demo/o/song.wav"
    "?alt=media&token=signed-token-value"
)


def wav_bytes(frames: int = 8, rate: int = 8000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()


class _Stream:
    def __init__(self, status, headers, payload):
        self.status = status
        self.headers = headers
        self.payload = payload
        self.closed = False

    def read(self, _amount):
        chunk = self.payload
        self.payload = b""
        return chunk

    def close(self):
        self.closed = True


class BeatSpy:
    def __init__(self):
        self.calls = []
        self.payload = {"success": True, "beats": [0.0, 0.5], "bpm": 120}

    def get_available_detectors(self):
        return ["madmom", "beat-transformer", "librosa"]

    def detect_beats(self, file_path, detector, force=False):
        self.calls.append({
            "file_path": file_path,
            "detector": detector,
            "force": force,
            "existed": os.path.exists(file_path),
        })
        return dict(self.payload)


class ChordSpy:
    def __init__(self):
        self.calls = []
        self.payload = {
            "success": True,
            "chords": [{"start": 0.0, "end": 1.0, "chord": "C:maj"}],
        }

    def get_available_detectors(self):
        return ["chord-cnn-lstm", "btc-sl", "btc-pl"]

    def recognize_chords(self, file_path, detector, chord_dict, force, use_spleeter):
        self.calls.append({
            "file_path": file_path,
            "detector": detector,
            "force": force,
            "use_spleeter": use_spleeter,
            "existed": os.path.exists(file_path),
        })
        return dict(self.payload)


def _body_transport(payload: bytes):
    streams = []

    def transport(_parts, _ip, _timeout):
        stream = _Stream(200, {"Content-Length": str(len(payload))}, payload)
        streams.append(stream)
        return RemoteResponse(stream.status, stream.headers, stream.read, stream.close)

    return transport, streams


class OffloadFlaskDispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        cls.app = create_app("testing")
        cls.app.config["TESTING"] = True

    def setUp(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        self.client = self.app.test_client()
        self.beats = BeatSpy()
        self.chords = ChordSpy()
        self.app.extensions["services"]["beat_detection"] = self.beats
        self.app.extensions["services"]["chord_recognition"] = self.chords

    def test_registered_routes_admit_wav_and_call_inference(self):
        rules = {rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertIn("/api/detect-beats-firebase", rules)
        self.assertIn("/api/recognize-chords-firebase", rules)
        payload = wav_bytes()
        transport, streams = _body_transport(payload)
        with patch("security.offload_audio.default_transport", transport), \
                patch("security.offload_audio.default_resolve", lambda _host: ["8.8.8.8"]):
            beats = self.client.post("/api/detect-beats-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "madmom",
                "force": "true",
            })
            chords = self.client.post("/api/recognize-chords-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "chord-cnn-lstm",
                "chord_dict": "full",
                "force": "true",
            })
        self.assertEqual(beats.status_code, 200)
        self.assertTrue(beats.get_json()["success"])
        self.assertEqual(self.beats.calls[0]["detector"], "madmom")
        self.assertFalse(self.beats.calls[0]["force"])
        self.assertTrue(self.beats.calls[0]["existed"])
        self.assertFalse(os.path.exists(self.beats.calls[0]["file_path"]))
        self.assertEqual(chords.status_code, 200)
        self.assertTrue(chords.get_json()["success"])
        self.assertFalse(self.chords.calls[0]["force"])
        self.assertFalse(os.path.exists(self.chords.calls[0]["file_path"]))
        self.assertTrue(all(stream.closed for stream in streams))
        self.assertNotIn("signed-token-value", beats.get_data(as_text=True))
        self.assertNotIn("signed-token-value", chords.get_data(as_text=True))

    def test_rejected_download_is_4xx_and_skips_inference(self):
        def transport(_parts, _ip, _timeout):
            return RemoteResponse(302, {"Location": "https://evil.example/file?token=signed-token-value"}, lambda _n: b"", lambda: None)

        with patch("security.offload_audio.default_transport", transport), \
                patch("security.offload_audio.default_resolve", lambda _host: ["8.8.8.8"]):
            response = self.client.post("/api/detect-beats-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "auto",
            })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "DESTINATION_FORBIDDEN")
        self.assertFalse(response.get_json()["success"])
        self.assertEqual(self.beats.calls, [])
        self.assertNotIn("signed-token-value", response.get_data(as_text=True))

    def test_private_dns_never_opens_the_transport(self):
        def transport(_parts, _ip, _timeout):
            raise AssertionError("connected")

        with patch("security.offload_audio.default_transport", transport), \
                patch("security.offload_audio.default_resolve", lambda _host: ["10.1.2.3"]):
            response = self.client.post("/api/recognize-chords-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "chord-cnn-lstm",
            })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "DESTINATION_FORBIDDEN")
        self.assertEqual(self.chords.calls, [])

    def test_inference_failure_is_http_500_for_both_routes(self):
        self.beats.payload = {"success": False, "error": "Madmom is not available"}
        self.chords.payload = {"success": False, "error": "Chord model is not available"}
        transport, _streams = _body_transport(wav_bytes())
        with patch("security.offload_audio.default_transport", transport), \
                patch("security.offload_audio.default_resolve", lambda _host: ["8.8.8.8"]):
            beats = self.client.post("/api/detect-beats-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "madmom",
            })
            chords = self.client.post("/api/recognize-chords-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "chord-cnn-lstm",
            })
        self.assertEqual(beats.status_code, 500)
        self.assertFalse(beats.get_json()["success"])
        self.assertEqual(beats.get_json()["error"], "Madmom is not available")
        self.assertEqual(chords.status_code, 500)
        self.assertFalse(chords.get_json()["success"])
        self.assertNotIn("traceback", chords.get_data(as_text=True))
        self.assertEqual(len(self.beats.calls), 1)
        self.assertEqual(len(self.chords.calls), 1)

    def test_flac_offload_is_rejected_while_local_upload_still_accepts_it(self):
        flac = b"fLaC" + (b"\x00" * 24)
        transport, _streams = _body_transport(flac)
        with patch("security.offload_audio.default_transport", transport), \
                patch("security.offload_audio.default_resolve", lambda _host: ["8.8.8.8"]):
            remote = self.client.post("/api/detect-beats-firebase", data={
                "firebase_url": SIGNED_URL,
                "detector": "madmom",
            })
        self.assertEqual(remote.status_code, 400)
        self.assertEqual(remote.get_json()["code"], "UNSUPPORTED_OFFLOAD_FORMAT")
        self.assertIn("WAV", remote.get_json()["error"])
        self.assertIn("FLAC", remote.get_json()["error"])
        self.assertEqual(self.beats.calls, [])

        local = self.client.post("/api/detect-beats", data={
            "file": (io.BytesIO(flac), "song.flac"),
            "detector": "madmom",
        })
        self.assertEqual(local.status_code, 200)
        self.assertTrue(local.get_json()["success"])
        self.assertEqual(len(self.beats.calls), 1)

    def test_protected_mode_blocks_both_firebase_routes_before_download(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "required"
        os.environ["CHORDMINI_INFERENCE_SECRET"] = "c" * 32

        def transport(_parts, _ip, _timeout):
            raise AssertionError("connected")

        with patch("security.offload_audio.default_transport", transport):
            beats = self.client.post("/api/detect-beats-firebase", data={"firebase_url": SIGNED_URL})
            chords = self.client.post("/api/recognize-chords-firebase", data={"firebase_url": SIGNED_URL})
        self.assertEqual(beats.status_code, 403)
        self.assertEqual(beats.get_json()["code"], "ENDPOINT_DISABLED")
        self.assertEqual(chords.status_code, 403)
        self.assertEqual(chords.get_json()["code"], "ENDPOINT_DISABLED")
        self.assertEqual(self.beats.calls, [])
        self.assertEqual(self.chords.calls, [])


if __name__ == "__main__":
    unittest.main()
