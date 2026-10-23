"""Decode and analyze the BACKEND-04G synthetic WAV and LAME MP3 fixtures.

The audio is generated in this process. It is not a copyrighted recording.
Madmom and Chord-CNN-LSTM run in-process. This script does not bind a socket
and does not print a credential.
"""

import hashlib
import json
import os
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DIR = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

EVIDENCE_PATH = RESEARCH_DIR / "backend_04g_decode_evidence.json"
OUT_DIR = Path("/tmp/chordmini-04g")
SAMPLE_REGIONS = (
    {"start": 0.0, "end": 4.0, "chord": "C:maj"},
    {"start": 4.0, "end": 8.0, "chord": "F:maj"},
    {"start": 8.0, "end": 12.0, "chord": "G:maj"},
)
GROUND_BPM = 120.0
FABRICATED = [
    {"start": 0.0, "end": 2.0, "chord": "C:maj"},
    {"start": 2.0, "end": 4.0, "chord": "F:maj"},
    {"start": 4.0, "end": 6.0, "chord": "G:maj"},
    {"start": 6.0, "end": 8.0, "chord": "C:maj"},
]


def peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_runner():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "backend_02_runner",
        RESEARCH_DIR / "run_minimum_inference.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synchsafe_size(size: int) -> bytes:
    return bytes((
        (size >> 21) & 0x7F,
        (size >> 14) & 0x7F,
        (size >> 7) & 0x7F,
        size & 0x7F,
    ))


def strip_leading_id3(data: bytes) -> bytes:
    """Remove one leading ID3v2 tag so the fixture has raw LAME frames.

    ffmpeg writes a small ID3v2.4 tag in front of those frames. The large-tag
    fixture then adds one tag of its own. Two stacked tags are not the case
    under test.
    """
    if len(data) < 10 or data[:3] != b"ID3":
        return data
    major = data[3]
    if major < 2 or major > 4 or any(byte & 0x80 for byte in data[6:10]):
        raise SystemExit("encoder ID3 tag is not a simple synchsafe header")
    size = (
        ((data[6] & 0x7F) << 21)
        | ((data[7] & 0x7F) << 14)
        | ((data[8] & 0x7F) << 7)
        | (data[9] & 0x7F)
    )
    total = 10 + size + (10 if data[5] & 0x10 else 0)
    if total > len(data):
        raise SystemExit("encoder ID3 tag is truncated")
    return data[total:]


def id3v2(payload: bytes) -> bytes:
    return b"ID3" + bytes((3, 0, 0)) + synchsafe_size(len(payload)) + payload


def probe(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration:stream=codec_name,sample_rate,channels",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = json.loads(completed.stdout)
    stream = (parsed.get("streams") or [{}])[0]
    return {
        "codec": stream.get("codec_name"),
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "channels": stream.get("channels"),
        "duration_seconds": float(parsed.get("format", {}).get("duration", 0)),
    }


def decoded_energy(path: Path) -> dict:
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(str(path), always_2d=False)
    array = np.asarray(samples, dtype=np.float64)
    return {
        "decoded_samples": int(array.shape[0]),
        "decoded_rate": int(rate),
        "decoded_seconds": round(float(array.shape[0]) / float(rate), 6),
        "peak_abs": round(float(np.max(np.abs(array))), 6),
    }


def write_fixtures() -> dict:
    runner = load_runner()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = OUT_DIR / "master.wav"
    mp3_path = OUT_DIR / "lame.mp3"
    tagged_path = OUT_DIR / "lame-id3.mp3"
    wav = runner.write_fixture(wav_path)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is not installed")
    subprocess.run(
        [
            ffmpeg, "-y", "-i", str(wav_path),
            "-codec:a", "libmp3lame", "-b:a", "128k",
            "-write_xing", "1",
            str(mp3_path),
        ],
        check=True,
        capture_output=True,
    )
    mp3_path.write_bytes(strip_leading_id3(mp3_path.read_bytes()))
    # One ID3v2.3 TIT2 frame. The text is longer than 4096 bytes. The size
    # field is a normal v2.3 integer, and the tag header size is synchsafe.
    title = b"ChordMini synthetic fixture. " + (b"x" * 5000)
    frame_data = b"\x00" + title
    frame = b"TIT2" + len(frame_data).to_bytes(4, "big") + b"\x00\x00" + frame_data
    tagged_path.write_bytes(id3v2(frame) + mp3_path.read_bytes())
    fixtures = {}
    for name, path in (("wav", wav_path), ("mp3", mp3_path), ("large_id3", tagged_path)):
        info = probe(path)
        energy = decoded_energy(path)
        fixtures[name] = {
            "path": str(path),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "channels_generated": 1,
            "provenance": "Synthetic C/F/G triads and 120 BPM clicks from run_minimum_inference.write_fixture, then LAME via ffmpeg libmp3lame. No external recording.",
            **info,
            **energy,
        }
    fixtures["wav"]["generator_sha256"] = wav["sha256"]
    fixtures["wav"]["click_interval_seconds"] = 0.5
    fixtures["ground_truth"] = {
        "regions": list(SAMPLE_REGIONS),
        "bpm": GROUND_BPM,
        "confidence_note": "Chord-CNN-LSTM confidence 1.0 is the lab parser placeholder, not a measured score.",
    }
    return fixtures


def slim(result: dict) -> dict:
    keep = (
        "success", "beats", "downbeats", "bpm", "time_signature", "model_used",
        "model_name", "chords", "total_chords", "duration", "chord_dict",
        "processing_time", "error",
    )
    return {key: result.get(key) for key in keep if key in result}


def labeled_chords(rows):
    return [row for row in rows or [] if row.get("chord") not in (None, "N")]


def compare_to_ground(chords: dict, beats: dict) -> dict:
    rows = labeled_chords(chords.get("chords"))
    deltas = []
    for expected, actual in zip(SAMPLE_REGIONS, rows):
        deltas.append({
            "expected_chord": expected["chord"],
            "observed_chord": actual.get("chord"),
            "start_delta_seconds": round(float(actual.get("start", 0)) - expected["start"], 6),
            "end_delta_seconds": round(float(actual.get("end", 0)) - expected["end"], 6),
        })
    fabricated = [
        {"start": row.get("start"), "end": row.get("end"), "chord": row.get("chord")}
        for row in (chords.get("chords") or [])
    ] == FABRICATED
    bpm = beats.get("bpm")
    return {
        "chord_deltas": deltas,
        "label_match": [item["expected_chord"] == item["observed_chord"] for item in deltas],
        "bpm": bpm,
        "bpm_delta": None if bpm is None else round(float(bpm) - GROUND_BPM, 6),
        "fabricated_pattern_returned": fabricated,
    }


def analyze(services, path: Path) -> dict:
    beats_service, chord_service = services
    started = time.perf_counter()
    beats = beats_service.detect_beats(str(path), detector="madmom", force=False)
    beat_seconds = time.perf_counter() - started
    started = time.perf_counter()
    chords = chord_service.recognize_chords(
        str(path),
        detector="chord-cnn-lstm",
        chord_dict="submission",
        force=False,
        use_spleeter=False,
    )
    chord_seconds = time.perf_counter() - started
    return {
        "beat_wall_seconds": round(beat_seconds, 4),
        "chord_wall_seconds": round(chord_seconds, 4),
        "beats": slim(beats),
        "chords": slim(chords),
        "ground_truth": compare_to_ground(chords, beats),
        "peak_memory_mb": round(peak_mb(), 2),
    }


def main() -> int:
    os.environ.setdefault("TESTING", "1")
    fixtures = write_fixtures()
    from security.inference_guard import sniff_audio

    sniff = {
        name: sniff_audio(item["path"])
        for name, item in fixtures.items()
        if name in ("wav", "mp3", "large_id3")
    }
    init_started = time.perf_counter()
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    beats_service = BeatDetectionService()
    chord_service = ChordRecognitionService()
    init_seconds = round(time.perf_counter() - init_started, 4)
    services = (beats_service, chord_service)

    cold_started = time.perf_counter()
    wav_cold = analyze(services, Path(fixtures["wav"]["path"]))
    cold_total = round(time.perf_counter() - cold_started, 4)
    wav_warm = analyze(services, Path(fixtures["wav"]["path"]))
    mp3 = analyze(services, Path(fixtures["mp3"]["path"]))
    large = analyze(services, Path(fixtures["large_id3"]["path"]))

    def same_labels(left, right):
        left_rows = labeled_chords(left["chords"].get("chords"))
        right_rows = labeled_chords(right["chords"].get("chords"))
        return [
            {
                "wav": a.get("chord"),
                "other": b.get("chord"),
                "start_delta_seconds": round(float(b.get("start", 0)) - float(a.get("start", 0)), 6),
            }
            for a, b in zip(left_rows, right_rows)
        ]

    evidence = {
        "firebase_identity": "NOT_USED_IN_THIS_PROCESS",
        "listener": "none",
        "fixtures": fixtures,
        "flask_sniff": sniff,
        "model_init_seconds": init_seconds,
        "cold_wav_pass_seconds": cold_total,
        "warm_wav": wav_warm,
        "results": {
            "wav": wav_cold,
            "mp3": mp3,
            "large_id3": large,
        },
        "wav_versus_mp3_chords": same_labels(wav_cold, mp3),
        "wav_versus_large_id3_chords": same_labels(wav_cold, large),
        "wav_versus_mp3_bpm": {
            "wav": wav_cold["beats"].get("bpm"),
            "mp3": mp3["beats"].get("bpm"),
            "large_id3": large["beats"].get("bpm"),
        },
        "peak_memory_mb": round(peak_mb(), 2),
    }
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"evidence={EVIDENCE_PATH}")
    print(f"sniff={sniff}")
    for name in ("wav", "mp3", "large_id3"):
        item = evidence["results"][name]
        print(
            f"{name} beats={item['beats'].get('success')} bpm={item['beats'].get('bpm')} "
            f"chords={item['chords'].get('success')} count={len(item['chords'].get('chords') or [])} "
            f"beat_s={item['beat_wall_seconds']} chord_s={item['chord_wall_seconds']}"
        )
    failures = []
    if sniff != {"wav": "wav", "mp3": "mp3", "large_id3": "mp3"}:
        failures.append(f"sniff {sniff}")
    for name, item in evidence["results"].items():
        if not item["beats"].get("success") or item["beats"].get("model_used") != "madmom":
            failures.append(f"{name} beats")
        if not item["chords"].get("success") or item["chords"].get("model_used") != "chord-cnn-lstm":
            failures.append(f"{name} chords")
        if item["ground_truth"]["fabricated_pattern_returned"]:
            failures.append(f"{name} fabricated")
    for name in ("mp3", "large_id3"):
        if fixtures[name]["peak_abs"] <= 0:
            failures.append(f"{name} silent")
    if failures:
        print("failures=" + ",".join(failures))
        return 1
    print("inference=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
