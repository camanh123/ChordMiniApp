"""Localhost authentication and upload guards for the two inference routes.

These tests use Flask's in-process client. They do not bind a socket.
The real-model regression is a separate process in the isolated environment.
"""

import io
import json
import logging
import os
import secrets
import subprocess
import sys
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.environ.pop("PORT", None)
os.environ.pop("FLASK_ENV", None)
os.environ.pop("REDIS_URL", None)
os.environ["TESTING"] = "1"

from app_factory import create_app  # noqa: E402
from security.inference_guard import (  # noqa: E402
    AUTH_HEADER,
    credentials_match,
    sniff_audio,
)

BASELINE = "573b0c88c1d00a7942bcceefd04a92e362338836"
FROZEN_PATHS = [
    "electron",
    "src",
    ".github/workflows/windows-installer.yml",
    "package.json",
    "package-lock.json",
]
# BACKEND-04A through 04G may change the forwarder, the staging gate, the
# desktop bridge, the single-process admission guard, the MP3 frame walk,
# and the Flask ID3v2 sniff skip. DESKTOP-UX-02 may change the local
# practice entry and its dictionary copy. The Electron shell, installer,
# and inference modules stay frozen outside this list.
ALLOWED_INTEGRATION_PATHS = {
    "src/app/analyze/page.tsx",
    "src/app/api/practice-inference-notice/route.ts",
    "src/components/analysis/LocalPracticeEntry.tsx",
    "src/i18n/catalog.ts",
    "src/server/practiceInferenceNotice.ts",
    "src/app/api/detect-beats/route.ts",
    "src/app/api/recognize-chords/route.ts",
    "src/app/api/config/route.ts",
    "src/server/inferenceUpstream.ts",
    "src/server/hostedStagingAuth.ts",
    "src/server/hostedGatewayForward.ts",
    "src/server/gatewayAdmission.ts",
    "src/server/gatewayAudioGuard.ts",
    "src/server/mp3FrameDuration.ts",
    "src/services/audio/inferenceUserToken.ts",
    "src/services/audio/beatDetectionService.ts",
    "src/services/chord-analysis/chordService.ts",
    "src/desktop/diagnostics.ts",
    "src/desktop/ownedServer.ts",
    "src/desktop/inferenceBoundary.ts",
}


def wav_bytes(frames: int = 32) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\x00\x10" * frames)
    return buffer.getvalue()


def mp3_bytes() -> bytes:
    # MPEG-1 Layer III frame header plus padding. The sniff test only needs
    # a real frame header, not a decodable stream.
    return b"\xff\xfb\x90\x00" + (b"\x00" * 64)


class BeatSpy:
    def __init__(self):
        self.calls = []
        self.payload = {
            "success": True,
            "beats": [0.0, 0.5, 1.0],
            "downbeats": [0.0],
            "bpm": 120.0,
            "time_signature": "4/4",
            "model_used": "madmom",
            "model_name": "Madmom",
            "processing_time": 0.01,
        }
        self.failure = None
        self.exploding = None

    def detect_beats(self, file_path, detector, force):
        existed = os.path.exists(file_path)
        self.calls.append({
            "file_path": file_path,
            "detector": detector,
            "force": force,
            "existed": existed,
        })
        if self.exploding is not None:
            raise self.exploding
        if self.failure is not None:
            body = dict(self.failure)
            if body.get("error") == "__PATH__":
                body["error"] = f"Audio file not found: {file_path}"
            if body.get("traceback") == "__PATH__":
                body["traceback"] = file_path
            return body
        return dict(self.payload)


class ChordSpy:
    def __init__(self):
        self.calls = []
        self.payload = {
            "success": True,
            "chords": [
                {"start": 0.0, "end": 1.0, "chord": "C:maj", "confidence": 0.5},
            ],
            "total_chords": 1,
            "duration": 1.0,
            "model_used": "chord-cnn-lstm",
            "model_name": "Chord-CNN-LSTM",
            "chord_dict": "submission",
            "processing_time": 0.02,
            "spleeter_info": None,
        }

    def recognize_chords(self, file_path, detector, chord_dict, force, use_spleeter):
        self.calls.append({
            "file_path": file_path,
            "detector": detector,
            "chord_dict": chord_dict,
            "force": force,
            "use_spleeter": use_spleeter,
            "existed": os.path.exists(file_path),
        })
        return dict(self.payload)


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


class InferenceSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app("testing")
        cls.app.config["TESTING"] = True

    def setUp(self):
        self.secret = secrets.token_hex(32)
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "required"
        os.environ["CHORDMINI_INFERENCE_SECRET"] = self.secret
        os.environ.pop("CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES", None)
        os.environ.pop("CHORDMINI_INFERENCE_MAX_UPLOAD_MB", None)
        self.app.config["PRODUCTION_MODE"] = False
        self.beats = BeatSpy()
        self.chords = ChordSpy()
        self.app.extensions["services"]["beat_detection"] = self.beats
        self.app.extensions["services"]["chord_recognition"] = self.chords
        self.client = self.app.test_client()
        self.handler = ListHandler()
        logging.getLogger().addHandler(self.handler)
        logging.getLogger("utils.logging").addHandler(self.handler)

    def tearDown(self):
        logging.getLogger().removeHandler(self.handler)
        logging.getLogger("utils.logging").removeHandler(self.handler)
        os.environ.pop("CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES", None)

    def headers(self, token=None):
        if token is None:
            token = self.secret
        return {AUTH_HEADER: token}

    def post_audio(self, path, payload, filename, extra=None, headers=None, query=""):
        data = {"file": (io.BytesIO(payload), filename)}
        if extra:
            data.update(extra)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            response = self.client.post(path + query, data=data, headers=headers or {})
        self.stdout = stdout.getvalue()
        return response

    def leftovers(self):
        return list(Path(tempfile.gettempdir()).glob("chordmini_upload_*"))

    def assert_clean(self, response, forbidden):
        body = response.get_data(as_text=True)
        combined = body + "\n" + self.stdout + "\n" + "\n".join(self.handler.messages)
        for secret in forbidden:
            self.assertNotIn(secret, combined)
        self.assertNotIn("traceback", body.lower())

    def test_missing_secret_fails_closed_without_inference(self):
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        before = self.leftovers()
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav", headers=self.headers("present"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "AUTH_NOT_CONFIGURED")
        self.assertEqual(self.beats.calls, [])
        self.assertEqual(self.leftovers(), before)
        self.assert_clean(response, ["present"])

    def test_short_and_placeholder_secrets_fail_closed(self):
        os.environ["CHORDMINI_INFERENCE_SECRET"] = "x" * 31
        short = self.post_audio("/api/recognize-chords", wav_bytes(), "tone.wav", headers=self.headers("x" * 31))
        self.assertEqual(short.status_code, 503)
        os.environ["CHORDMINI_INFERENCE_SECRET"] = "dev-secret-key-change-in-production"
        placeholder = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "tone.wav",
            headers=self.headers("dev-secret-key-change-in-production"),
        )
        self.assertEqual(placeholder.status_code, 503)
        self.assertEqual(self.beats.calls, [])
        self.assertEqual(self.chords.calls, [])

    def test_production_config_ignores_local_override_and_fails_closed(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        self.app.config["PRODUCTION_MODE"] = True
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "AUTH_NOT_CONFIGURED")
        self.assertEqual(self.beats.calls, [])

    def test_missing_credential_is_rejected_before_inference(self):
        response = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "tone.wav",
            extra={"detector": "madmom"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["code"], "AUTH_REQUIRED")
        self.assertEqual(self.beats.calls, [])
        self.assert_clean(response, [self.secret])

    def test_invalid_credential_is_rejected_before_inference(self):
        wrong = secrets.token_hex(32)
        response = self.post_audio(
            "/api/recognize-chords",
            wav_bytes(),
            "tone.wav",
            headers=self.headers(wrong),
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["code"], "AUTH_FAILED")
        self.assertEqual(self.chords.calls, [])
        self.assert_clean(response, [self.secret, wrong])

    def test_authorization_bearer_is_not_accepted(self):
        response = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "tone.wav",
            headers={"Authorization": f"Bearer {self.secret}"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.beats.calls, [])
        self.assert_clean(response, [self.secret])

    def test_valid_credential_preserves_service_payload(self):
        before = self.leftovers()
        response = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "notes.txt",
            extra={"detector": "madmom", "force": "true"},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), json.loads(json.dumps(self.beats.payload)))
        self.assertEqual(len(self.beats.calls), 1)
        self.assertTrue(self.beats.calls[0]["existed"])
        self.assertEqual(self.beats.calls[0]["detector"], "madmom")
        self.assertTrue(self.beats.calls[0]["force"])
        self.assertFalse(os.path.exists(self.beats.calls[0]["file_path"]))
        self.assertEqual(self.leftovers(), before)
        self.assert_clean(response, [self.secret, self.beats.calls[0]["file_path"]])

        chord = self.post_audio(
            "/api/recognize-chords",
            wav_bytes(),
            "tone.wav",
            extra={"detector": "chord-cnn-lstm", "chord_dict": "submission"},
            headers=self.headers(),
        )
        self.assertEqual(chord.status_code, 200)
        self.assertEqual(chord.get_json(), json.loads(json.dumps(self.chords.payload)))
        self.assertEqual(self.chords.calls[0]["chord_dict"], "submission")
        self.assertFalse(self.chords.calls[0]["use_spleeter"])
        self.assertFalse(os.path.exists(self.chords.calls[0]["file_path"]))

    def test_service_failure_status_stays_on_the_existing_contract(self):
        self.beats.failure = {"success": False, "error": "Madmom is not available", "model_used": "madmom"}
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav", headers=self.headers())
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["error"], "Madmom is not available")
        self.assertNotIn("traceback", response.get_json())

    def test_credentials_in_the_url_are_rejected(self):
        response = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "tone.wav",
            headers=self.headers(),
            query=f"?token={self.secret}",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "CREDENTIALS_IN_URL")
        self.assertEqual(self.beats.calls, [])
        self.assert_clean(response, [self.secret])

        health = io.StringIO()
        with redirect_stdout(health):
            health_response = self.client.get(f"/health?secret={self.secret}")
        self.stdout = health.getvalue()
        self.assertEqual(health_response.status_code, 400)
        self.assertNotIn(self.secret, health_response.get_data(as_text=True))

    def test_arbitrary_filesystem_paths_are_rejected(self):
        private = Path(tempfile.mkdtemp()) / "secret-audio.wav"
        private.write_bytes(wav_bytes())
        private_text = str(private)
        real_open = open
        real_exists = os.path.exists

        def guarding_open(file, *args, **kwargs):
            if isinstance(file, (str, os.PathLike)) and os.path.abspath(file) == str(private):
                raise AssertionError("caller path was opened")
            return real_open(file, *args, **kwargs)

        def guarding_exists(file):
            if os.path.abspath(file) == str(private):
                raise AssertionError("caller path was inspected")
            return real_exists(file)

        with patch("builtins.open", guarding_open), patch("os.path.exists", guarding_exists):
            denied = self.client.post(
                "/api/detect-beats",
                data={"audio_path": private_text, "detector": "madmom"},
                headers=self.headers(),
            )
            self.stdout = ""
            both = self.post_audio(
                "/api/detect-beats",
                wav_bytes(),
                "tone.wav",
                extra={"audio_path": private_text},
                headers=self.headers(),
            )
            remote = self.client.post(
                "/api/recognize-chords",
                json={"audioUrl": "/audio/../../etc/passwd", "detector": "auto"},
                headers=self.headers(),
            )
        self.assertEqual(denied.status_code, 400)
        self.assertEqual(denied.get_json()["code"], "AUDIO_PATH_REJECTED")
        self.assertEqual(both.status_code, 400)
        self.assertEqual(remote.status_code, 400)
        self.assertEqual(self.beats.calls, [])
        self.assertEqual(self.chords.calls, [])
        self.assertNotIn(private_text, denied.get_data(as_text=True))
        self.assertNotIn(private_text, both.get_data(as_text=True))
        self.assertNotIn("/etc/passwd", remote.get_data(as_text=True))
        self.assertNotIn("passwd", remote.get_data(as_text=True))

    def test_oversized_uploads_fail_before_inference(self):
        os.environ["CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES"] = "20000"
        payload = wav_bytes(frames=12000)
        self.assertGreater(len(payload), 20000)
        self.assertLess(len(payload), 20000 + 16384)
        before = self.leftovers()
        response = self.post_audio(
            "/api/detect-beats",
            payload,
            "big.wav",
            extra={"force": "true"},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["code"], "UPLOAD_TOO_LARGE")
        self.assertEqual(self.beats.calls, [])
        self.assertEqual(self.leftovers(), before)
        self.assert_clean(response, [self.secret])

        os.environ["CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES"] = "100"
        early = self.post_audio(
            "/api/recognize-chords",
            wav_bytes(frames=12000),
            "early.wav",
            headers=self.headers(),
        )
        self.assertEqual(early.status_code, 413)
        self.assertEqual(self.chords.calls, [])

        unauthenticated = self.post_audio("/api/detect-beats", payload, "big.wav")
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(self.beats.calls, [])

    def test_malformed_audio_fails_and_is_removed(self):
        before = self.leftovers()
        response = self.post_audio(
            "/api/recognize-chords",
            b"this is definitely not audio content!!" * 8,
            "song.wav",
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "INVALID_AUDIO")
        self.assertEqual(self.chords.calls, [])
        self.assertEqual(self.leftovers(), before)
        self.assert_clean(response, [self.secret])

    def test_model_exception_is_generic_and_cleans_up(self):
        self.beats.exploding = RuntimeError(f"broke {self.secret} at /tmp/private/song.wav")
        before = self.leftovers()
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav", headers=self.headers())
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["code"], "INFERENCE_FAILED")
        self.assertEqual(response.get_json()["error"], "Inference failed")
        self.assertEqual(len(self.beats.calls), 1)
        self.assertFalse(os.path.exists(self.beats.calls[0]["file_path"]))
        self.assertEqual(self.leftovers(), before)
        self.assert_clean(response, [self.secret, "/tmp/private/song.wav", self.beats.calls[0]["file_path"]])

    def test_service_error_string_cannot_leak_the_temp_path(self):
        self.beats.failure = {
            "success": False,
            "error": "__PATH__",
            "traceback": "__PATH__",
            "model_used": "madmom",
        }
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav", headers=self.headers())
        body = response.get_json()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(body["error"], "Inference failed")
        self.assertNotIn("traceback", body)
        self.assertNotIn("chordmini_upload_", response.get_data(as_text=True))
        self.assertFalse(os.path.exists(self.beats.calls[0]["file_path"]))

    def test_local_compatibility_keeps_health_and_still_rejects_paths(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json()["status"], "healthy")
        allowed = self.post_audio(
            "/api/detect-beats",
            wav_bytes(),
            "tone.wav",
            extra={"detector": "librosa"},
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(self.beats.calls[0]["detector"], "librosa")
        denied = self.client.post("/api/recognize-chords", data={"audio_path": "/etc/passwd"})
        self.assertEqual(denied.status_code, 400)
        self.assertEqual(denied.get_json()["code"], "AUDIO_PATH_REJECTED")
        self.assertNotIn("/etc/passwd", denied.get_data(as_text=True))
        self.assertEqual(self.chords.calls, [])

    def test_protected_mode_disables_remote_and_debug_routes(self):
        with patch("blueprints.beats.routes.requests.get", side_effect=AssertionError("downloaded")):
            firebase = self.client.post(
                "/api/detect-beats-firebase",
                data={"firebase_url": "https://example.invalid/track.mp3", "detector": "madmom"},
            )
        self.assertEqual(firebase.status_code, 403)
        self.assertEqual(firebase.get_json()["code"], "ENDPOINT_DISABLED")
        self.assertEqual(self.beats.calls, [])

        with patch("blueprints.songformer.routes.requests.patch", side_effect=AssertionError("patched")):
            songformer = self.client.post(
                "/api/songformer/segment",
                json={
                    "audioUrl": "https://example.invalid/track.mp3",
                    "asyncJob": {
                        "jobId": "job",
                        "updateToken": "token-value",
                        "callbackUrl": "https://example.invalid/callback",
                        "songContext": {"title": "demo"},
                    },
                },
            )
        self.assertEqual(songformer.status_code, 403)
        self.assertNotIn("token-value", songformer.get_data(as_text=True))

        lyrics_calls = []
        self.app.extensions["services"]["lyrics"] = type(
            "LyricsSpy",
            (),
            {"fetch_from_genius": lambda *args, **kwargs: lyrics_calls.append(kwargs)},
        )()
        lyrics = self.client.post("/api/genius-lyrics", json={"artist": "A", "title": "B"})
        self.assertEqual(lyrics.status_code, 403)
        self.assertEqual(lyrics_calls, [])

        debug = self.client.post("/api/debug-environment")
        self.assertEqual(debug.status_code, 403)
        self.assertNotIn(self.secret, debug.get_data(as_text=True))

    def test_local_debug_environment_redacts_the_secret(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        from blueprints.debug.routes import _redacted_environment

        visible = _redacted_environment()
        self.assertNotIn("CHORDMINI_INFERENCE_SECRET", visible)
        self.assertNotIn(self.secret, json.dumps(visible))
        debug = self.client.post("/api/debug-environment")
        self.assertEqual(debug.status_code, 200)
        self.assertNotIn(self.secret, debug.get_data(as_text=True))
        self.assertNotIn("CHORDMINI_INFERENCE_SECRET", debug.get_data(as_text=True))

    def test_local_firebase_route_remains_mounted_without_fetching(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "local"
        with patch("blueprints.beats.routes.requests.get", side_effect=AssertionError("downloaded")):
            response = self.client.post("/api/detect-beats-firebase", data={})
        self.assertEqual(response.status_code, 400)
        self.assertNotEqual(response.get_json().get("code"), "ENDPOINT_DISABLED")

    def test_unknown_mode_fails_closed(self):
        os.environ["CHORDMINI_INFERENCE_AUTH"] = "sometimes"
        os.environ.pop("CHORDMINI_INFERENCE_SECRET", None)
        response = self.post_audio("/api/detect-beats", wav_bytes(), "tone.wav", headers=self.headers())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.beats.calls, [])

    def test_credential_comparison_and_audio_sniff(self):
        self.assertTrue(credentials_match("a" * 40, "a" * 40))
        self.assertFalse(credentials_match("a" * 40, "a" * 39 + "b"))
        self.assertFalse(credentials_match("short", "much-longer-secret-value"))
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "clip.bin"
            wav_path.write_bytes(wav_bytes())
            self.assertEqual(sniff_audio(str(wav_path)), "wav")
            text_path = Path(directory) / "notes.wav"
            text_path.write_bytes(b"not audio at all!!!!")
            self.assertIsNone(sniff_audio(str(text_path)))
            mp3_path = Path(directory) / "clip.txt"
            mp3_path.write_bytes(mp3_bytes())
            self.assertEqual(sniff_audio(str(mp3_path)), "mp3")

    def test_large_id3v2_mp3_is_recognized_and_malformed_tags_are_rejected(self):
        frame = mp3_bytes()

        def tag(payload: bytes, major: int = 3, flags: int = 0, size: int | None = None) -> bytes:
            declared = len(payload) if size is None else size
            raw = bytes((
                (declared >> 21) & 0x7F,
                (declared >> 14) & 0x7F,
                (declared >> 7) & 0x7F,
                declared & 0x7F,
            ))
            return b"ID3" + bytes((major, 0, flags)) + raw + payload

        with tempfile.TemporaryDirectory() as directory:
            large = Path(directory) / "large.mp3"
            large.write_bytes(tag(b"A" * 5000) + frame)
            self.assertEqual(sniff_audio(str(large)), "mp3")
            response = self.post_audio(
                "/api/detect-beats",
                large.read_bytes(),
                "large.mp3",
                extra={"detector": "madmom"},
                headers=self.headers(),
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(self.beats.calls), 1)
            self.assertTrue(self.beats.calls[0]["existed"])
            self.assert_clean(response, [self.secret])
            self.assertEqual(self.leftovers(), [])

            self.beats.calls.clear()
            footer_payload = b"META"
            foot = tag(footer_payload, flags=0x10) + (b"3DI" + bytes(7)) + frame
            foot_path = Path(directory) / "footer.mp3"
            foot_path.write_bytes(foot)
            self.assertEqual(sniff_audio(str(foot_path)), "mp3")

            bad_size = bytearray(tag(b"A" * 32) + frame)
            bad_size[6] = 0x80
            bad_path = Path(directory) / "bad-size.mp3"
            bad_path.write_bytes(bad_size)
            self.assertIsNone(sniff_audio(str(bad_path)))

            truncated = Path(directory) / "truncated.mp3"
            truncated.write_bytes(tag(b"A" * 8, size=100000) + frame)
            self.assertIsNone(sniff_audio(str(truncated)))

            bad_version = Path(directory) / "version.mp3"
            bad_version.write_bytes(tag(b"A" * 8, major=1) + frame)
            self.assertIsNone(sniff_audio(str(bad_version)))

            for path in (bad_path, truncated, bad_version):
                self.beats.calls.clear()
                rejected = self.post_audio(
                    "/api/detect-beats",
                    path.read_bytes(),
                    path.name,
                    extra={"detector": "madmom"},
                    headers=self.headers(),
                )
                self.assertEqual(rejected.status_code, 400)
                self.assertIn("INVALID_AUDIO", rejected.get_data(as_text=True))
                self.assertEqual(self.beats.calls, [])

    def test_process_entry_binds_localhost_and_frozen_trees_are_untouched(self):
        source = (BACKEND_ROOT / "app.py").read_text(encoding="utf-8")
        self.assertIn("host='127.0.0.1'", source)
        self.assertNotIn("host='0.0.0.0'", source)
        completed = subprocess.run(
            ["git", "status", "--porcelain", "--", *FROZEN_PATHS],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.stdout.strip(), "")
        diff = subprocess.run(
            ["git", "diff", "--name-only", BASELINE, "--", *FROZEN_PATHS],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        unexpected = [
            line for line in diff.stdout.splitlines()
            if line and line not in ALLOWED_INTEGRATION_PATHS
        ]
        self.assertEqual(unexpected, [])

    def test_real_inference_regression_when_isolated_environment_exists(self):
        python = Path("/tmp/chordmini-bt02-venv/bin/python")
        if not python.is_file():
            self.skipTest("isolated inference environment is not present")
        script = BACKEND_ROOT / "research" / "check_inference_regression.py"
        completed = subprocess.run(
            [str(python), str(script)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=900,
            env={key: value for key, value in os.environ.items() if key != "CHORDMINI_INFERENCE_SECRET"},
        )
        self.assertNotIn(self.secret, completed.stdout)
        self.assertNotIn(self.secret, completed.stderr)
        self.assertEqual(
            completed.returncode,
            0,
            completed.stdout[-2000:] + "\n" + completed.stderr[-2000:],
        )
        self.assertIn("regression=PASS", completed.stdout)


if __name__ == "__main__":
    unittest.main()
