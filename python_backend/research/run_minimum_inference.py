"""Run one synthetic WAV through the existing Madmom and Chord-CNN-LSTM services.

The fixture is generated in this process. It is not a copyrighted recording.
The script calls the same service objects the Flask routes return. It does
not bind a socket.
"""

import hashlib
import importlib.metadata as importlib_metadata
import json
import resource
import sys
import time
import wave
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

EVIDENCE_PATH = Path(__file__).with_name("backend_02_inference_evidence.json")
FIXTURE_PATH = Path("/tmp/chordmini-bt02-fixture.wav")
SAMPLE_RATE = 22050
BEAT_CONTRACT = {
    "success",
    "beats",
    "downbeats",
    "bpm",
    "time_signature",
    "model_used",
    "model_name",
}
CHORD_CONTRACT = {
    "success",
    "chords",
    "total_chords",
    "duration",
    "model_used",
    "model_name",
    "chord_dict",
    "processing_time",
}
FABRICATED = [
    {"start": 0.0, "end": 2.0, "chord": "C:maj", "confidence": 1.0},
    {"start": 2.0, "end": 4.0, "chord": "F:maj", "confidence": 1.0},
    {"start": 4.0, "end": 6.0, "chord": "G:maj", "confidence": 1.0},
    {"start": 6.0, "end": 8.0, "chord": "C:maj", "confidence": 1.0},
]


def peak_mb() -> float:
    # Linux reports ru_maxrss in kilobytes.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def tone(frequency: float, seconds: float) -> np.ndarray:
    count = int(SAMPLE_RATE * seconds)
    time_axis = np.arange(count, dtype=np.float64) / SAMPLE_RATE
    signal = np.zeros(count, dtype=np.float64)
    for harmonic, weight in ((1, 1.0), (2, 0.35), (3, 0.18)):
        signal += weight * np.sin(2 * np.pi * frequency * harmonic * time_axis)
    envelope = np.linspace(0.0, 1.0, min(count, SAMPLE_RATE // 50), dtype=np.float64)
    signal[: envelope.size] *= envelope
    return signal


def write_fixture(path: Path) -> dict:
    # Four-second triads, plus a click every half second. The timestamps are
    # intentionally different from the removed two-second mock progression.
    chords = (
        (0.0, 4.0, (261.63, 329.63, 392.00)),  # C4 E4 G4
        (4.0, 8.0, (349.23, 440.00, 523.25)),  # F4 A4 C5
        (8.0, 12.0, (392.00, 493.88, 587.33)),  # G4 B4 D5
    )
    duration = 12.0
    mix = np.zeros(int(SAMPLE_RATE * duration), dtype=np.float64)
    for start, end, frequencies in chords:
        start_index = int(SAMPLE_RATE * start)
        chord = sum(tone(frequency, end - start) for frequency in frequencies)
        mix[start_index:start_index + chord.size] += chord
    click = np.hanning(int(SAMPLE_RATE * 0.02))
    for beat_time in np.arange(0.0, duration, 0.5):
        index = int(SAMPLE_RATE * beat_time)
        mix[index:index + click.size] += click * 1.5
    peak = np.max(np.abs(mix))
    pcm = np.clip(mix / peak * 0.8, -1.0, 1.0)
    frames = (pcm * 32767.0).astype(np.int16).tobytes()
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(frames)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": digest,
        "sample_rate": SAMPLE_RATE,
        "duration_seconds": duration,
        "click_interval_seconds": 0.5,
        "synthesized_regions": [
            {"start": start, "end": end, "frequencies_hz": frequencies}
            for start, end, frequencies in chords
        ],
        "license": "Generated in this script. No external recording.",
    }


def main() -> int:
    installed = {}
    for name in (
        "torch", "numpy", "scipy", "librosa", "numba", "soundfile", "madmom",
        "setuptools", "Cython", "h5py", "pretty_midi", "pydub", "scikit-learn",
        "soxr", "audioread", "joblib",
    ):
        try:
            installed[name] = importlib_metadata.version(name)
        except importlib_metadata.PackageNotFoundError:
            installed[name] = None
    evidence = {
        "python": sys.version,
        "installed": installed,
        "fixture": write_fixture(FIXTURE_PATH),
        "peak_memory_mb_after_fixture": round(peak_mb(), 2),
    }
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    evidence["peak_memory_mb_after_import"] = round(peak_mb(), 2)
    beats = BeatDetectionService()
    started = time.perf_counter()
    beat_result = beats.detect_beats(str(FIXTURE_PATH), detector="madmom", force=False)
    beat_seconds = time.perf_counter() - started
    evidence["beats"] = beat_result
    evidence["beat_wall_seconds"] = round(beat_seconds, 4)
    evidence["peak_memory_mb_after_beats"] = round(peak_mb(), 2)

    chords = ChordRecognitionService()
    started = time.perf_counter()
    chord_result = chords.recognize_chords(
        str(FIXTURE_PATH),
        detector="chord-cnn-lstm",
        chord_dict="submission",
        force=False,
        use_spleeter=False,
    )
    chord_seconds = time.perf_counter() - started
    evidence["chords"] = chord_result
    evidence["chord_wall_seconds"] = round(chord_seconds, 4)
    evidence["peak_memory_mb"] = round(peak_mb(), 2)
    evidence["fabricated_pattern_returned"] = chord_result.get("chords") == FABRICATED

    failures = []
    if not beat_result.get("success"):
        failures.append(f"beats failed: {beat_result.get('error')}")
    missing = BEAT_CONTRACT - set(beat_result)
    if missing:
        failures.append(f"beat response missing {sorted(missing)}")
    if beat_result.get("model_used") != "madmom":
        failures.append(f"beat model_used={beat_result.get('model_used')}")
    beat_times = beat_result.get("beats") or []
    if beat_result.get("success") and len(beat_times) < 4:
        failures.append(f"beat list too short: {len(beat_times)}")

    if not chord_result.get("success"):
        failures.append(f"chords failed: {chord_result.get('error')}")
    missing = CHORD_CONTRACT - set(chord_result)
    if missing:
        failures.append(f"chord response missing {sorted(missing)}")
    if chord_result.get("model_used") != "chord-cnn-lstm":
        failures.append(f"chord model_used={chord_result.get('model_used')}")
    if evidence["fabricated_pattern_returned"]:
        failures.append("chord response matched the removed fabricated progression")
    chord_rows = chord_result.get("chords") or []
    if chord_result.get("success"):
        if not chord_rows:
            failures.append("chord response contained no timestamps")
        for row in chord_rows:
            if not {"start", "end", "chord", "confidence"} <= set(row):
                failures.append(f"chord row missing contract keys: {row}")
                break
            if not (isinstance(row["start"], (int, float)) and isinstance(row["end"], (int, float))):
                failures.append(f"chord timestamps are not numeric: {row}")
                break
            if row["end"] < row["start"]:
                failures.append(f"chord end precedes start: {row}")
                break

    evidence["failures"] = failures
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2, default=str), encoding="utf-8")
    print(f"wrote {EVIDENCE_PATH}")
    print(f"beats success={beat_result.get('success')} model={beat_result.get('model_used')} count={len(beat_times)} bpm={beat_result.get('bpm')} seconds={beat_seconds:.2f}")
    print(f"chords success={chord_result.get('success')} model={chord_result.get('model_used')} count={len(chord_rows)} seconds={chord_seconds:.2f}")
    print(f"peak_memory_mb={evidence['peak_memory_mb']}")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
