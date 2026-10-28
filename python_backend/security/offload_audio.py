"""Bounded Firebase offload download and admission.

The Flask process is the authority for bytes actually downloaded and for
duration measured from those bytes. Content-Length is only an early hint.
A temporary filename is not format evidence. Signed query strings are never
copied into errors.

Direct MP3/WAV uploads do not use this module.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import ssl
import tempfile
import time
import urllib.parse
from dataclasses import dataclass
from typing import Callable, Iterable, Optional

from security.inference_guard import sniff_audio


MAX_OFFLOAD_BYTES = 100 * 1024 * 1024
MAX_OFFLOAD_DURATION_SECONDS = 720
CONNECT_TIMEOUT_SECONDS = 10.0
READ_TIMEOUT_SECONDS = 20.0
TOTAL_TIMEOUT_SECONDS = 120.0
MAX_REDIRECTS = 3
READ_CHUNK_BYTES = 64 * 1024
REDIRECT_BODY_LIMIT = 4096

ALLOWED_OFFLOAD_HOSTS = (
    "firebasestorage.googleapis.com",
    "storage.googleapis.com",
)

BEAT_SIZE_LIMITS_MB = {
    "beat-transformer": 100.0,
    "madmom": 200.0,
    "librosa": 500.0,
}
BEAT_PREFERENCE = ("madmom", "beat-transformer", "librosa")
CHORD_SIZE_LIMITS_MB = {
    "chord-cnn-lstm": 100.0,
    "btc-sl": 50.0,
    "btc-pl": 50.0,
}
CHORD_PREFERENCE = ("chord-cnn-lstm", "btc-sl", "btc-pl")

_REDIRECT_STATUS = {301, 302, 303, 307, 308}
_MPEG1_L3_KBPS = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_MPEG2_L3_KBPS = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
_SAMPLE_RATE = {
    1: (44100, 48000, 32000),
    2: (22050, 24000, 16000),
    2.5: (11025, 12000, 8000),
}


class OffloadRejected(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def body(self) -> dict:
        return {"success": False, "error": self.message, "code": self.code}


@dataclass
class RemoteResponse:
    status: int
    headers: dict
    read: Callable[[int], bytes]
    close: Callable[[], None]


Transport = Callable[[urllib.parse.SplitResult, str, float], RemoteResponse]
Resolver = Callable[[str], Iterable[str]]
Clock = Callable[[], float]


def host_allowed(hostname: str) -> bool:
    host = hostname.lower().rstrip(".")
    if not host or ".." in host:
        return False
    for allowed in ALLOWED_OFFLOAD_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return True
    return False


def validate_offload_url(url: str) -> urllib.parse.SplitResult:
    if not isinstance(url, str) or not url.strip():
        raise OffloadRejected(400, "BAD_OFFLOAD_URL", "The storage URL was rejected.")
    if any(char in url for char in ("\r", "\n", "\x00")):
        raise OffloadRejected(400, "BAD_OFFLOAD_URL", "The storage URL was rejected.")
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme != "https" or parts.username or parts.password:
        raise OffloadRejected(400, "BAD_OFFLOAD_URL", "The storage URL was rejected.")
    host = parts.hostname or ""
    if parts.port not in (None, 443) or not host_allowed(host):
        raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")
    return parts


def public_url_problem(url: str) -> Optional[str]:
    try:
        validate_offload_url(url)
    except OffloadRejected as rejected:
        return rejected.message
    return None


def choose_detector(family: str, requested: str, size_bytes: int, available: Iterable[str]) -> Optional[str]:
    """Fail closed. Offload does not substitute a detector that exceeds its limit."""
    limits = BEAT_SIZE_LIMITS_MB if family == "beat" else CHORD_SIZE_LIMITS_MB
    preference = BEAT_PREFERENCE if family == "beat" else CHORD_PREFERENCE
    names = set(available)
    size_mb = size_bytes / (1024 * 1024)
    order = preference if requested == "auto" else (requested,)
    for name in order:
        limit = limits.get(name)
        if name in names and limit is not None and size_mb <= limit:
            return name
    return None


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return bool(address.is_global)


def _assert_resolved(ips: Iterable[str]) -> str:
    chosen = None
    for raw in ips:
        if not _public_ip(raw):
            raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")
        if chosen is None:
            chosen = raw
    if chosen is None:
        raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")
    return chosen


def _header(headers: dict, name: str) -> Optional[str]:
    for key, value in headers.items():
        if str(key).lower() == name:
            return None if value is None else str(value)
    return None


def _declared_length(headers: dict) -> Optional[int]:
    raw = _header(headers, "content-length")
    if raw is None or raw.strip() == "":
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    return value


class _PinnedHTTPSConnection(object):
    def __init__(self, hostname: str, ip: str, timeout: float, port: int = 443, context=None):
        import http.client
        self._conn = http.client.HTTPSConnection(
            hostname,
            port,
            timeout=timeout,
            context=context or ssl.create_default_context(),
        )
        self._ip = ip
        self._port = port
        self._hostname = hostname
        self._timeout = timeout

    def request(self, path: str):
        self._conn.connect = self._connect  # type: ignore[method-assign]
        try:
            self._conn.request("GET", path, headers={"Accept": "*/*", "User-Agent": "ChordMiniOffload"})
            response = self._conn.getresponse()
        except Exception:
            self.close()
            raise
        if self._conn.sock is not None:
            self._conn.sock.settimeout(READ_TIMEOUT_SECONDS)
        return response

    def _connect(self):
        raw = socket.create_connection((self._ip, self._port), self._timeout)
        self._conn.sock = self._conn._context.wrap_socket(raw, server_hostname=self._hostname)

    def close(self):
        self._conn.close()


def default_resolve(hostname: str) -> Iterable[str]:
    infos = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def default_transport(parts: urllib.parse.SplitResult, ip: str, timeout: float) -> RemoteResponse:
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    conn = _PinnedHTTPSConnection(parts.hostname or "", ip, timeout)
    try:
        response = conn.request(path)
    except OffloadRejected:
        raise
    except (TimeoutError, socket.timeout):
        conn.close()
        raise OffloadRejected(408, "DOWNLOAD_TIMEOUT", "The audio download timed out.") from None
    except Exception:
        conn.close()
        raise OffloadRejected(502, "DOWNLOAD_FAILED", "The audio download was rejected.") from None
    headers = {key: value for key, value in response.getheaders()}

    def read(amount: int) -> bytes:
        return response.read(amount)

    def close() -> None:
        response.close()
        conn.close()

    return RemoteResponse(status=response.status, headers=headers, read=read, close=close)


def _drain(response: RemoteResponse, limit: int) -> None:
    remaining = limit
    while remaining > 0:
        chunk = response.read(min(READ_CHUNK_BYTES, remaining))
        if not chunk:
            break
        remaining -= len(chunk)


def download_offload_to_path(
    url: str,
    dest: str,
    *,
    transport: Optional[Transport] = None,
    resolve: Optional[Resolver] = None,
    clock: Optional[Clock] = None,
) -> int:
    opener = transport or default_transport
    resolver = resolve or default_resolve
    now = clock or time.monotonic
    started = now()
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        if now() - started > TOTAL_TIMEOUT_SECONDS:
            raise OffloadRejected(408, "DOWNLOAD_TIMEOUT", "The audio download timed out.")
        parts = validate_offload_url(current)
        ip = _assert_resolved(resolver(parts.hostname or ""))
        response = opener(parts, ip, CONNECT_TIMEOUT_SECONDS)
        try:
            if response.status in _REDIRECT_STATUS:
                location = _header(response.headers, "location")
                _drain(response, REDIRECT_BODY_LIMIT)
                if not location:
                    raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")
                current = urllib.parse.urljoin(current, location)
                continue
            if response.status != 200:
                raise OffloadRejected(400, "DOWNLOAD_FAILED", "The audio download was rejected.")
            declared = _declared_length(response.headers)
            if declared is not None and (declared < 0 or declared > MAX_OFFLOAD_BYTES):
                raise OffloadRejected(413, "DOWNLOAD_TOO_LARGE", "The audio download is too large.")
            total = 0
            with open(dest, "wb") as handle:
                while True:
                    if now() - started > TOTAL_TIMEOUT_SECONDS:
                        raise OffloadRejected(408, "DOWNLOAD_TIMEOUT", "The audio download timed out.")
                    try:
                        chunk = response.read(READ_CHUNK_BYTES)
                    except (TimeoutError, socket.timeout):
                        raise OffloadRejected(408, "DOWNLOAD_TIMEOUT", "The audio download timed out.")
                    except OSError:
                        raise OffloadRejected(400, "DOWNLOAD_INTERRUPTED", "The audio download was interrupted.")
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_OFFLOAD_BYTES:
                        raise OffloadRejected(413, "DOWNLOAD_TOO_LARGE", "The audio download is too large.")
                    handle.write(chunk)
            if total <= 0:
                raise OffloadRejected(400, "DOWNLOAD_EMPTY", "The audio download was empty.")
            return total
        finally:
            response.close()
    raise OffloadRejected(400, "DESTINATION_FORBIDDEN", "The storage host was rejected.")


def _measure_wav(path: str) -> Optional[float]:
    """Duration from the fmt and data chunks. A short header cannot claim a long file."""
    file_size = os.path.getsize(path)
    rate = 0
    block_align = 0
    with open(path, "rb") as handle:
        prefix = handle.read(12)
        if len(prefix) < 12 or prefix[:4] != b"RIFF" or prefix[8:12] != b"WAVE":
            return None
        while handle.tell() + 8 <= file_size:
            header = handle.read(8)
            if len(header) < 8:
                return None
            ident = header[:4]
            size = int.from_bytes(header[4:8], "little")
            if size < 0 or handle.tell() + size > file_size:
                return None
            if ident == b"fmt ":
                fmt = handle.read(size)
                if len(fmt) < 16:
                    return None
                channels = int.from_bytes(fmt[2:4], "little")
                rate = int.from_bytes(fmt[4:8], "little")
                block_align = int.from_bytes(fmt[12:14], "little")
                if channels <= 0 or rate <= 0 or block_align <= 0:
                    return None
                if size & 1:
                    handle.seek(1, os.SEEK_CUR)
                continue
            if ident == b"data":
                if rate <= 0 or block_align <= 0:
                    return None
                frames = size // block_align
                return frames / float(rate)
            handle.seek(size + (size & 1), os.SEEK_CUR)
    return None


def _synchsafe(raw: bytes) -> Optional[int]:
    if len(raw) != 4 or any(byte & 0x80 for byte in raw):
        return None
    return ((raw[0] & 0x7F) << 21) | ((raw[1] & 0x7F) << 14) | ((raw[2] & 0x7F) << 7) | (raw[3] & 0x7F)


def _measure_mp3(path: str, max_seconds: float) -> Optional[float]:
    file_size = os.path.getsize(path)
    with open(path, "rb") as handle:
        header = handle.read(10)
        offset = 0
        if header[:3] == b"ID3":
            if len(header) < 10:
                return None
            major = header[3]
            if major < 2 or major > 4:
                return None
            size = _synchsafe(header[6:10])
            if size is None:
                return None
            offset = 10 + size + (10 if header[5] & 0x10 else 0)
            if offset > file_size:
                return None
        frames = 0
        total_samples = 0
        sample_rate = 0
        version = 0
        while offset < file_size:
            handle.seek(offset)
            raw = handle.read(4)
            if len(raw) < 4 or raw[0] != 0xFF or (raw[1] & 0xE0) != 0xE0:
                break
            version_bits = (raw[1] >> 3) & 0x03
            layer_bits = (raw[1] >> 1) & 0x03
            if version_bits == 1 or layer_bits != 1:
                return None
            version_now = 1 if version_bits == 3 else 2 if version_bits == 2 else 2.5
            bitrate_index = (raw[2] >> 4) & 0x0F
            sample_index = (raw[2] >> 2) & 0x03
            padding = (raw[2] >> 1) & 0x01
            if bitrate_index in (0, 15) or sample_index == 3:
                return None
            table = _MPEG1_L3_KBPS if version_now == 1 else _MPEG2_L3_KBPS
            kbps = table[bitrate_index]
            rate = _SAMPLE_RATE[version_now][sample_index]
            samples = 1152 if version_now == 1 else 576
            length = int((samples / 8) * (kbps * 1000) / rate) + padding
            if length < 4 or offset + length > file_size:
                return None
            if frames == 0:
                sample_rate = rate
                version = version_now
            elif rate != sample_rate or version_now != version:
                return None
            next_samples = total_samples + samples
            if sample_rate and next_samples > max_seconds * sample_rate:
                return float("inf")
            total_samples = next_samples
            frames += 1
            if frames > 20000:
                return None
            offset += length
        if frames == 0 or sample_rate == 0:
            return None
        return total_samples / float(sample_rate)


def measure_duration_seconds(path: str, kind: str) -> Optional[float]:
    if kind == "wav":
        return _measure_wav(path)
    if kind == "mp3":
        return _measure_mp3(path, MAX_OFFLOAD_DURATION_SECONDS)
    return None


_LOCAL_ONLY_OFFLOAD_KINDS = {
    "flac": "FLAC",
    "ogg": "OGG",
    "aiff": "AIFF",
    "mp4": "MP4",
}


def assess_offload_file(path: str) -> tuple[str, float]:
    kind = sniff_audio(path)
    if kind not in ("wav", "mp3"):
        if _measure_wav(path) == 0.0:
            raise OffloadRejected(400, "DURATION_INVALID", "Audio duration is not a positive length.")
        label = _LOCAL_ONLY_OFFLOAD_KINDS.get(kind or "")
        if label:
            raise OffloadRejected(
                400,
                "UNSUPPORTED_OFFLOAD_FORMAT",
                f"Firebase offload accepts WAV and MP3. This file is {label}.",
            )
        raise OffloadRejected(
            400,
            "INVALID_AUDIO",
            "Firebase offload accepts WAV and MP3. The downloaded bytes are not one of those formats.",
        )
    seconds = measure_duration_seconds(path, kind)
    if seconds is None:
        raise OffloadRejected(400, "DURATION_FAILED", "Audio duration could not be read.")
    if seconds == float("inf"):
        raise OffloadRejected(413, "DURATION_EXCEEDED", "Audio duration exceeds 12 minutes.")
    if not (seconds > 0) or seconds != seconds:
        raise OffloadRejected(400, "DURATION_INVALID", "Audio duration is not a positive length.")
    if seconds > MAX_OFFLOAD_DURATION_SECONDS:
        raise OffloadRejected(413, "DURATION_EXCEEDED", "Audio duration exceeds 12 minutes.")
    return kind, seconds


def sanitize_inference_result(result, temp_path: str):
    if not isinstance(result, dict):
        return {"success": False, "error": "Inference failed"}
    cleaned = dict(result)
    cleaned.pop("traceback", None)
    error = cleaned.get("error")
    if isinstance(error, str) and (
        (temp_path and temp_path in error)
        or "http://" in error.lower()
        or "https://" in error.lower()
        or "token=" in error.lower()
    ):
        cleaned["error"] = "Inference failed"
    return cleaned


def execute_offload(
    url: str,
    *,
    family: str,
    requested: str,
    available: Iterable[str],
    infer: Callable[[str, str], dict],
    transport: Optional[Transport] = None,
    resolve: Optional[Resolver] = None,
    clock: Optional[Clock] = None,
):
    fd, path = tempfile.mkstemp(prefix="chordmini_offload_", suffix=".bin")
    os.close(fd)
    try:
        size = download_offload_to_path(url, path, transport=transport, resolve=resolve, clock=clock)
        assess_offload_file(path)
        chosen = choose_detector(family, requested, size, available)
        if chosen is None:
            raise OffloadRejected(413, "NO_ELIGIBLE_DETECTOR", "No detector can accept this audio.")
        result = infer(path, chosen)
        return sanitize_inference_result(result, path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
