"""Authentication and upload guards for the two primary inference routes.

This is a localhost research control, not a production authentication
architecture. The shared secret stays in the Flask process environment.
It must not be placed in a browser bundle, a NEXT_PUBLIC variable, an
Electron installer, or an iPad package.

Protected routes:
- POST /api/detect-beats
- POST /api/recognize-chords

Mode:
- CHORDMINI_INFERENCE_AUTH=required, or any production config: a secret of
  at least 32 characters is mandatory. Missing or weak configuration fails
  closed before inference. Callers send X-ChordMini-Inference-Token.
- CHORDMINI_INFERENCE_AUTH=local, or an unset mode on a non-production
  config: documented local compatibility. Those two routes still reject
  server file paths, cap uploads, and validate audio bytes. Unrelated
  routes keep their existing behavior.
- A local override is ignored when the loaded config is production.
  Unknown mode values fail closed.

Hazardous adjacent routes stay mounted for local compatibility and are
disabled when this mode is required, so a future production process cannot
serve them by accident.
"""

import hashlib
import hmac
import os
import wave
from contextlib import contextmanager
from typing import Dict, Iterator, Optional

from flask import current_app, jsonify, request

from services.audio.tempfiles import temporary_directory
from utils.logging import log_error, log_info


AUTH_HEADER = "X-ChordMini-Inference-Token"
SECRET_ENV = "CHORDMINI_INFERENCE_SECRET"
MODE_ENV = "CHORDMINI_INFERENCE_AUTH"
UPLOAD_BYTES_ENV = "CHORDMINI_INFERENCE_MAX_UPLOAD_BYTES"
UPLOAD_MB_ENV = "CHORDMINI_INFERENCE_MAX_UPLOAD_MB"
MIN_SECRET_LENGTH = 32
DEFAULT_UPLOAD_MB = 50
MULTIPART_OVERHEAD_BYTES = 16 * 1024
UPLOAD_PREFIX = "chordmini_upload_"
AUDIO_SUFFIX = {
    "wav": ".wav",
    "mp3": ".mp3",
    "flac": ".flac",
    "ogg": ".ogg",
    "aiff": ".aiff",
    "mp4": ".m4a",
}

PROTECTED_POST_ROUTES = frozenset({
    "/api/detect-beats",
    "/api/recognize-chords",
})

# Remote fetch, caller-controlled callbacks, traceback probes, and arbitrary
# URL downloaders. Disabled whenever inference auth is required.
DISABLED_WHEN_PROTECTED = frozenset({
    "/api/detect-beats-firebase",
    "/api/recognize-chords-firebase",
    "/api/test-beat-transformer",
    "/api/test-madmom",
    "/api/test-librosa",
    "/api/test-all-models",
    "/api/test-dbn-isolation",
    "/api/test-chord-cnn-lstm",
    "/api/test-btc-sl",
    "/api/test-btc-pl",
    "/api/test-all-chord-models",
    "/api/debug-btc",
    "/api/test-btc-import",
    "/api/debug-chord-cnn-lstm",
    "/api/debug-environment",
    "/debug/files",
    "/api/songformer/segment",
    "/api/genius-lyrics",
    "/api/lrclib-lyrics",
})

QUERY_CREDENTIAL_KEYS = frozenset({
    "x-chordmini-inference-token",
    "inference_token",
    "inference-token",
    "token",
    "secret",
    "api_key",
    "apikey",
    "access_token",
    "authorization",
    "password",
    "credential",
    "credentials",
})

SERVER_PATH_KEYS = (
    "audio_path",
    "audioUrl",
    "audio_url",
    "audioPath",
    "file_path",
    "filepath",
    "firebase_url",
    "path",
)

BEAT_DETECTORS = frozenset({"beat-transformer", "madmom", "librosa", "auto"})
CHORD_DETECTORS = frozenset({"chord-cnn-lstm", "btc-sl", "btc-pl", "auto"})
CHORD_DICTS = frozenset({"full", "ismir2017", "submission", "extended", "large_voca"})

WEAK_SECRETS = frozenset({
    "dev-secret-key-change-in-production",
    "replace_with_random_secret",
    "changeme",
    "password",
    "secret",
})


class InferenceRejected(Exception):
    """A request that must not reach model inference."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def response(self):
        return json_error(self.status, self.code, self.message)


def json_error(status: int, code: str, message: str):
    return jsonify({"success": False, "error": message, "code": code}), status


def inference_auth_mode(production_mode: bool) -> str:
    """Return 'required' or 'local'. Production and unknown values fail closed."""
    if production_mode:
        return "required"
    requested = os.environ.get(MODE_ENV, "").strip().lower()
    if requested in ("", "local"):
        return "local"
    return "required"


def configured_secret() -> Optional[str]:
    """Return the research secret, or None when it is missing or too weak."""
    raw = os.environ.get(SECRET_ENV)
    if raw is None:
        return None
    value = raw.strip()
    if len(value) < MIN_SECRET_LENGTH:
        return None
    if value.lower() in WEAK_SECRETS:
        return None
    flask_secret = os.environ.get("SECRET_KEY")
    if flask_secret and value == flask_secret.strip():
        return None
    return value


def credentials_match(provided: str, expected: str) -> bool:
    """Compare credentials without an early return on the first differing byte."""
    if not provided or not expected:
        return False
    provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(provided_digest, expected_digest)


def upload_limit_bytes() -> int:
    """Finite upload cap. ``force=true`` cannot raise it."""
    raw_bytes = os.environ.get(UPLOAD_BYTES_ENV, "").strip()
    if raw_bytes:
        try:
            value = int(raw_bytes)
        except ValueError:
            return 0
        return value if value > 0 else 0

    raw_mb = os.environ.get(UPLOAD_MB_ENV, "").strip()
    if raw_mb:
        try:
            megabytes = int(raw_mb)
        except ValueError:
            return 0
        if megabytes <= 0:
            return 0
        limit = megabytes * 1024 * 1024
    else:
        configured = DEFAULT_UPLOAD_MB
        try:
            configured = int(current_app.config.get("DIRECT_UPLOAD_SIZE_LIMIT_MB", DEFAULT_UPLOAD_MB))
        except (TypeError, ValueError):
            configured = DEFAULT_UPLOAD_MB
        if configured <= 0:
            return 0
        limit = configured * 1024 * 1024

    ceiling = current_app.config.get("MAX_CONTENT_LENGTH")
    if isinstance(ceiling, int) and ceiling > 0:
        limit = min(limit, ceiling)
    return limit


def credentials_in_query() -> bool:
    for key in request.args.keys():
        if str(key).lower() in QUERY_CREDENTIAL_KEYS:
            return True
    return False


def _presented_token() -> str:
    value = request.headers.get(AUTH_HEADER, "")
    if not isinstance(value, str):
        return ""
    return value.strip()


def _production_mode() -> bool:
    return bool(current_app.config.get("PRODUCTION_MODE", False))


def guard_before_request():
    """Reject secrets in URLs, disable hazardous routes, and authenticate POSTs."""
    if credentials_in_query():
        log_info("Rejected request because credentials were sent in the URL")
        return json_error(400, "CREDENTIALS_IN_URL", "Credentials must not be sent in the URL.")

    mode = inference_auth_mode(_production_mode())
    if mode == "required" and request.path in DISABLED_WHEN_PROTECTED:
        log_info("Blocked a hazardous endpoint in protected inference mode")
        return json_error(403, "ENDPOINT_DISABLED", "Endpoint disabled")

    if request.path not in PROTECTED_POST_ROUTES or request.method != "POST":
        return None

    if mode == "local":
        return None

    secret = configured_secret()
    if secret is None:
        log_error("Inference authentication is not configured")
        return json_error(
            503,
            "AUTH_NOT_CONFIGURED",
            "Inference authentication is not configured",
        )

    presented = _presented_token()
    if not presented:
        log_info("Rejected inference request: authentication required")
        return json_error(401, "AUTH_REQUIRED", "Authentication required")
    if not credentials_match(presented, secret):
        log_info("Rejected inference request: authentication failed")
        return json_error(401, "AUTH_FAILED", "Authentication failed")

    limit = upload_limit_bytes()
    if request.content_length is not None and request.content_length > limit + MULTIPART_OVERHEAD_BYTES:
        log_info("Rejected inference upload before reading the file body")
        return json_error(413, "UPLOAD_TOO_LARGE", "The uploaded file is too large.")
    return None


def _present(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True


def reject_server_audio_sources() -> None:
    """Refuse caller-chosen server paths and remote URLs on the primary routes."""
    for key in SERVER_PATH_KEYS:
        if _present(request.values.get(key)):
            raise InferenceRejected(
                400,
                "AUDIO_PATH_REJECTED",
                "Server file paths are not accepted. Upload the audio file.",
            )
    if not request.is_json:
        return
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return
    for key in SERVER_PATH_KEYS:
        if _present(payload.get(key)):
            raise InferenceRejected(
                400,
                "AUDIO_PATH_REJECTED",
                "Server file paths are not accepted. Upload the audio file.",
            )


def _flag(name: str) -> bool:
    raw = request.args.get(name, request.form.get(name, ""))
    return str(raw).strip().lower() == "true"


def beat_params() -> Dict[str, object]:
    detector = str(request.form.get("detector", "auto")).strip().lower()
    if detector not in BEAT_DETECTORS:
        raise InferenceRejected(400, "INVALID_DETECTOR", "Invalid detector.")
    return {"detector": detector, "force": _flag("force")}


def chord_params() -> Dict[str, object]:
    detector = str(request.form.get("detector", "auto")).strip().lower()
    if detector not in CHORD_DETECTORS:
        raise InferenceRejected(400, "INVALID_DETECTOR", "Invalid detector.")
    chord_dict = request.form.get("chord_dict")
    if isinstance(chord_dict, str):
        chord_dict = chord_dict.strip()
        if chord_dict == "":
            chord_dict = None
    if chord_dict is not None and chord_dict not in CHORD_DICTS:
        raise InferenceRejected(400, "INVALID_CHORD_DICT", "Invalid chord dictionary.")
    return {
        "detector": detector,
        "chord_dict": chord_dict,
        "force": _flag("force"),
        "use_spleeter": _flag("use_spleeter"),
    }


def _write_capped(stream, destination: str, limit: int) -> str:
    total = 0
    try:
        stream.seek(0)
    except Exception:
        pass
    with open(destination, "wb") as output:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                return "too_large"
            output.write(chunk)
    if total <= 0:
        return "empty"
    return "ok"


def _synchsafe(raw: bytes) -> Optional[int]:
    if len(raw) != 4 or any(byte & 0x80 for byte in raw):
        return None
    return (
        ((raw[0] & 0x7F) << 21)
        | ((raw[1] & 0x7F) << 14)
        | ((raw[2] & 0x7F) << 7)
        | (raw[3] & 0x7F)
    )


def _id3v2_audio_offset(header: bytes, file_size: int) -> Optional[int]:
    """Byte offset of the audio that follows one leading ID3v2 tag.

    A file that does not start with ID3 returns 0. A tag with a bad version,
    a non-synchsafe size, or a declared span past the file returns None.
    The optional footer flag adds its 10 bytes. The tag body is not read.
    """
    if len(header) < 3 or header[:3] != b"ID3":
        return 0
    if len(header) < 10 or file_size < 10:
        return None
    major = header[3]
    if major < 2 or major > 4:
        return None
    size = _synchsafe(header[6:10])
    if size is None:
        return None
    total = 10 + size
    if header[5] & 0x10:
        total += 10
    if total < 10 or total > file_size:
        return None
    return total


def _mp3_frame(sample: bytes) -> bool:
    last = max(0, len(sample) - 3)
    for index in range(0, last):
        if sample[index] != 0xFF:
            continue
        second = sample[index + 1]
        if (second & 0xE0) != 0xE0:
            continue
        version = (second >> 3) & 0x03
        layer = (second >> 1) & 0x03
        if version == 1 or layer == 0:
            continue
        third = sample[index + 2]
        bitrate = (third >> 4) & 0x0F
        sample_rate = (third >> 2) & 0x03
        if bitrate in (0, 15) or sample_rate == 3:
            continue
        return True
    return False


def sniff_audio(path: str) -> Optional[str]:
    """Identify audio from file bytes. The filename is not consulted."""
    with open(path, "rb") as handle:
        head = handle.read(12)
        if len(head) < 12:
            return None
        if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
            try:
                with wave.open(path, "rb") as wav:
                    if wav.getnchannels() <= 0 or wav.getsampwidth() <= 0 or wav.getnframes() <= 0:
                        return None
                    if wav.getframerate() <= 0:
                        return None
            except (wave.Error, EOFError):
                return None
            return "wav"
        if head[:4] == b"fLaC":
            return "flac"
        if head[:4] == b"OggS":
            return "ogg"
        if head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"):
            return "aiff"
        if len(head) >= 8 and head[4:8] == b"ftyp":
            return "mp4"
        file_size = os.path.getsize(path)
        audio_at = _id3v2_audio_offset(head, file_size)
        if audio_at is None:
            return None
        if audio_at > file_size:
            return None
        handle.seek(audio_at)
        sample = handle.read(4096)
    if _mp3_frame(sample):
        return "mp3"
    return None


@contextmanager
def capped_audio_upload() -> Iterator[str]:
    upload = request.files.get("file")
    filename = getattr(upload, "filename", None) if upload is not None else None
    if upload is None or not isinstance(filename, str) or filename.strip() == "":
        raise InferenceRejected(
            400,
            "AUDIO_REQUIRED",
            "No audio file provided. Upload the audio as multipart form data.",
        )

    limit = upload_limit_bytes()
    if limit <= 0 or (
        request.content_length is not None
        and request.content_length > limit + MULTIPART_OVERHEAD_BYTES
    ):
        raise InferenceRejected(413, "UPLOAD_TOO_LARGE", "The uploaded file is too large.")

    with temporary_directory(prefix=UPLOAD_PREFIX) as directory:
        raw_path = os.path.join(directory, "upload.bin")
        status = _write_capped(upload.stream, raw_path, limit)
        if status == "too_large":
            raise InferenceRejected(413, "UPLOAD_TOO_LARGE", "The uploaded file is too large.")
        kind = sniff_audio(raw_path) if status == "ok" else None
        if kind is None:
            raise InferenceRejected(
                400,
                "INVALID_AUDIO",
                "The uploaded file is not a supported audio format.",
            )
        final_path = os.path.join(directory, "audio" + AUDIO_SUFFIX[kind])
        os.replace(raw_path, final_path)
        yield final_path


def _leaks(value: str, secret: Optional[str], temp_path: str) -> bool:
    if secret and secret in value:
        return True
    if temp_path and temp_path in value:
        return True
    markers = ("/tmp/", "/var/", "/home/", "/Users/", "/workspace/", "/app/", "chordmini_upload_")
    if any(marker in value for marker in markers):
        return True
    if len(value) > 2 and value[1] == ":" and value[2] in ("\\", "/"):
        return True
    return False


def public_inference_result(result, secret: Optional[str], temp_path: str):
    """Keep a successful service payload. Strip leaked paths from failures."""
    if not isinstance(result, dict):
        return {"success": False, "error": "Inference failed"}
    cleaned = dict(result)
    cleaned.pop("traceback", None)
    error = cleaned.get("error")
    if isinstance(error, str) and _leaks(error, secret, temp_path):
        cleaned["error"] = "Inference failed"
    return cleaned


def _service(name: str):
    services = current_app.extensions.get("services") or {}
    return services.get(name)


def _run(service_name: str, unavailable: str, invoke, failure_status: int):
    try:
        # Defense in depth if a request reaches the view without the guard.
        early = guard_before_request()
        if early is not None:
            return early
        reject_server_audio_sources()
        service = _service(service_name)
        if service is None:
            return json_error(503, "SERVICE_UNAVAILABLE", unavailable)
        with capped_audio_upload() as path:
            try:
                result = invoke(service, path)
            except InferenceRejected:
                raise
            except Exception:
                # Log a fixed message so model exceptions cannot copy a path or secret.
                log_error("Inference failed")
                return json_error(500, "INFERENCE_FAILED", "Inference failed")
            payload = public_inference_result(result, configured_secret(), path)
        if not isinstance(result, dict):
            return json_error(500, "INFERENCE_FAILED", "Inference failed")
        status = 200 if result.get("success") else failure_status
        return jsonify(payload), status
    except InferenceRejected as rejected:
        return rejected.response()
    except Exception:
        log_error("Inference failed")
        return json_error(500, "INFERENCE_FAILED", "Inference failed")


def handle_beat_upload():
    # Validate the detector name before a temporary file is written.
    try:
        early = guard_before_request()
        if early is not None:
            return early
        reject_server_audio_sources()
        params = beat_params()
    except InferenceRejected as rejected:
        return rejected.response()

    return _run(
        "beat_detection",
        "Beat detection is not available",
        lambda service, path: service.detect_beats(
            file_path=path,
            detector=params["detector"],
            force=params["force"],
        ),
        failure_status=500,
    )


def handle_chord_upload():
    params = {}
    try:
        early = guard_before_request()
        if early is not None:
            return early
        reject_server_audio_sources()
        params = chord_params()
    except InferenceRejected as rejected:
        return rejected.response()

    # Existing chord responses stay HTTP 200 when the service returns success=false.
    return _run(
        "chord_recognition",
        "Chord recognition is not available",
        lambda service, path: service.recognize_chords(
            file_path=path,
            detector=params["detector"],
            chord_dict=params["chord_dict"],
            force=params["force"],
            use_spleeter=params["use_spleeter"],
        ),
        failure_status=200,
    )
