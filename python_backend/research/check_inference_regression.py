"""Replay the BACKEND-02 fixture and compare genuine model output.

The committed evidence file is the reference. This script does not overwrite
it, does not bind a socket, and does not print the research secret.
"""

import importlib.util
import json
import os
import secrets
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DIR = Path(__file__).resolve().parent
EVIDENCE_PATH = RESEARCH_DIR / "backend_02_inference_evidence.json"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(RESEARCH_DIR) not in sys.path:
    sys.path.insert(0, str(RESEARCH_DIR))

FABRICATED = [
    {"start": 0.0, "end": 2.0, "chord": "C:maj", "confidence": 1.0},
    {"start": 2.0, "end": 4.0, "chord": "F:maj", "confidence": 1.0},
    {"start": 4.0, "end": 6.0, "chord": "G:maj", "confidence": 1.0},
    {"start": 6.0, "end": 8.0, "chord": "C:maj", "confidence": 1.0},
]
BEAT_TOLERANCE = 1e-3
CHORD_TOLERANCE = 1e-3


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "backend_02_runner",
        RESEARCH_DIR / "run_minimum_inference.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def close_enough(actual, expected, tolerance):
    if len(actual) != len(expected):
        return False
    return all(abs(float(left) - float(right)) <= tolerance for left, right in zip(actual, expected))


def compare_beats(actual, expected):
    failures = []
    if not actual.get("success"):
        failures.append("beat request failed")
    if actual.get("model_used") != "madmom" or expected.get("model_used") != "madmom":
        failures.append("beat model_used changed")
    if actual.get("model_name") != expected.get("model_name"):
        failures.append("beat model_name changed")
    if abs(float(actual.get("bpm", -1)) - float(expected.get("bpm", -2))) > 0.01:
        failures.append("beat bpm changed")
    if actual.get("time_signature") != expected.get("time_signature"):
        failures.append("beat time_signature changed")
    if not close_enough(actual.get("beats") or [], expected.get("beats") or [], BEAT_TOLERANCE):
        failures.append("beat timestamps changed")
    if not close_enough(actual.get("downbeats") or [], expected.get("downbeats") or [], BEAT_TOLERANCE):
        failures.append("downbeat timestamps changed")
    return failures


def compare_chords(actual, expected):
    failures = []
    if not actual.get("success"):
        failures.append("chord request failed")
    if actual.get("model_used") != "chord-cnn-lstm":
        failures.append("chord model_used changed")
    if actual.get("chord_dict") != expected.get("chord_dict"):
        failures.append("chord_dict changed")
    if actual.get("chords") == FABRICATED:
        failures.append("fabricated chord progression returned")
    actual_rows = actual.get("chords") or []
    expected_rows = expected.get("chords") or []
    if len(actual_rows) != len(expected_rows):
        failures.append("chord row count changed")
        return failures
    for index, (left, right) in enumerate(zip(actual_rows, expected_rows)):
        if left.get("chord") != right.get("chord"):
            failures.append(f"chord label changed at row {index}")
        if abs(float(left.get("start", -1)) - float(right.get("start", -2))) > CHORD_TOLERANCE:
            failures.append(f"chord start changed at row {index}")
        if abs(float(left.get("end", -1)) - float(right.get("end", -2))) > CHORD_TOLERANCE:
            failures.append(f"chord end changed at row {index}")
    return failures


def run_direct(wav_path):
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    beats = BeatDetectionService().detect_beats(str(wav_path), detector="madmom", force=False)
    chords = ChordRecognitionService().recognize_chords(
        str(wav_path),
        detector="chord-cnn-lstm",
        chord_dict="submission",
        force=False,
        use_spleeter=False,
    )
    return beats, chords, "direct-service"


def run_flask(wav_path):
    secret = secrets.token_hex(32)
    os.environ["TESTING"] = "1"
    os.environ["CHORDMINI_INFERENCE_AUTH"] = "required"
    os.environ["CHORDMINI_INFERENCE_SECRET"] = secret
    os.environ.pop("PORT", None)
    os.environ.pop("FLASK_ENV", None)
    from app_factory import create_app

    app = create_app("testing")
    client = app.test_client()
    header = {"X-ChordMini-Inference-Token": secret}
    with open(wav_path, "rb") as handle:
        beat_response = client.post(
            "/api/detect-beats",
            data={"detector": "madmom", "file": (handle, "fixture.wav")},
            headers=header,
        )
    with open(wav_path, "rb") as handle:
        chord_response = client.post(
            "/api/recognize-chords",
            data={
                "detector": "chord-cnn-lstm",
                "chord_dict": "submission",
                "file": (handle, "fixture.wav"),
            },
            headers=header,
        )
    if secret in beat_response.get_data(as_text=True) or secret in chord_response.get_data(as_text=True):
        raise RuntimeError("inference response exposed the research secret")
    if beat_response.status_code != 200 or chord_response.status_code != 200:
        raise RuntimeError(
            f"authorized inference status beats={beat_response.status_code} chords={chord_response.status_code}"
        )
    return beat_response.get_json(), chord_response.get_json(), "flask-test-client"


def main() -> int:
    evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
    runner = load_runner()
    fixture = runner.write_fixture(runner.FIXTURE_PATH)
    failures = []
    if fixture["sha256"] != evidence["fixture"]["sha256"]:
        failures.append("fixture hash changed")

    try:
        import flask  # noqa: F401
        beats, chords, channel = run_flask(fixture["path"])
    except ImportError:
        beats, chords, channel = run_direct(fixture["path"])

    failures.extend(compare_beats(beats, evidence["beats"]))
    failures.extend(compare_chords(chords, evidence["chords"]))
    print(f"channel={channel}")
    print(
        f"beats success={beats.get('success')} count={len(beats.get('beats') or [])} "
        f"bpm={beats.get('bpm')} model={beats.get('model_used')}"
    )
    print(
        f"chords success={chords.get('success')} count={len(chords.get('chords') or [])} "
        f"model={chords.get('model_used')}"
    )
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("regression=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
