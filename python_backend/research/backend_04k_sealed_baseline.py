"""BACKEND-04K sealed GuitarSet baseline.

`--seal` writes the pre-registered manifest and its SHA-256. It does not run
a model. `--run` refuses to score unless that manifest is unchanged, then runs
the existing Madmom and Chord-CNN-LSTM paths once.

Audio stays under /tmp/chordmini-04k. Locked-test per-recording outputs go to
a seal file. This script does not tune BPM bounds, HMM penalties, vocabulary,
or weights.
"""

import hashlib
import http.client
import json
import os
import platform
import secrets
import socket
import subprocess
import sys
import time
import wave
from pathlib import Path

RESEARCH_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = RESEARCH_DIR.parent
if str(RESEARCH_DIR) not in sys.path:
    sys.path.insert(0, str(RESEARCH_DIR))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from backend_04i_guitarset_eval import (  # noqa: E402
    audio_probe,
    beat_reference,
    chord_layers,
    cpu_info,
    in_submission_vocabulary,
    load_jams,
    load_submission_labels,
    peak_mb,
    predicted_segments,
    rows_to_segments,
    sha256,
    slim,
)
from backend_04k_metrics import (  # noqa: E402
    DEVELOPMENT_IDS,
    DIAGNOSTIC_IDS,
    ERRATA_IDS,
    LOCKED_TEST_IDS,
    METRIC_CONTRACT,
    aggregate_by_style,
    aggregate_recordings,
    assert_split_integrity,
    parse_recording_id,
    score_recording,
)

CORPUS = Path("/tmp/chordmini-04k")
AUDIO_DIR = CORPUS / "audio"
ANNOTATION_DIR = CORPUS / "annotation"
SOURCE_AUDIO_ZIP = Path("/tmp/chordmini-04i/audio_mono-mic.zip")
SOURCE_ANNOTATION_ZIP = Path("/tmp/chordmini-04i/annotation.zip")
MANIFEST_PATH = RESEARCH_DIR / "backend_04k_manifest.json"
MANIFEST_SHA_PATH = RESEARCH_DIR / "backend_04k_manifest.sha256"
EVIDENCE_PATH = RESEARCH_DIR / "backend_04k_evidence.json"
SEAL_PATH = RESEARCH_DIR / "backend_04k_locked_test_seal.json"
PRIOR_EVIDENCE_PATH = RESEARCH_DIR / "backend_04i_guitarset_evidence.json"
CHECKPOINT_PATH = CORPUS / "checkpoint.json"
MADMOM_MODELS = Path("/tmp/chordmini-bt02-venv/lib/python3.10/site-packages/madmom/models/beats/2015")
CHORD_WEIGHTS = BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "cache_data"
CONFIG_FILES = (
    BACKEND_ROOT / "services" / "detectors" / "madmom_detector.py",
    BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "chord_recognition.py",
    BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "extractors" / "xhmm_ismir.py",
    BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "data" / "submission_chord_list.txt",
)
DETECTOR_CONFIG = {
    "beat_processor": "RNNBeatProcessor()",
    "beat_weights": "madmom BEATS_BLSTM beats/2015/beats_blstm_1.pkl through beats_blstm_8.pkl",
    "beat_tracker": "DBNBeatTrackingProcessor(fps=100)",
    "dbn_defaults": {
        "min_bpm": 55.0,
        "max_bpm": 215.0,
        "transition_lambda": 100,
        "observation_lambda": 16,
        "correct": True,
        "threshold": 0,
        "num_tempi": None,
    },
    "downbeats": "heuristic beat_times[::4], with [::3] retained as a candidate. DBNDownBeatTrackingProcessor is not called.",
    "chord_detector": "chord-cnn-lstm",
    "chord_dict": "submission",
    "chord_weights": "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0.best.sdict through s4",
    "hmm": "XHMMDecoder defaults, decode_to_chordlab(use_layer_decode=False, use_beats=False, use_downbeats=False)",
    "use_spleeter": False,
    "key_context_at_inference": False,
}


def canonical(payload: dict) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def digest(payload: dict) -> str:
    return hashlib.sha256(canonical(payload)).hexdigest()


def file_sha_map(paths) -> dict:
    return {path.name: sha256(path) for path in sorted(paths, key=lambda item: item.name)}


def wav_facts(path: Path) -> dict:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        frames = handle.getnframes()
        return {
            "sample_rate": rate,
            "channels": handle.getnchannels(),
            "sample_width_bytes": handle.getsampwidth(),
            "frames": frames,
            "duration_seconds": round(frames / rate, 6),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        }


def annotation_facts(path: Path) -> dict:
    payload = load_jams(path)
    return {
        "sha256": sha256(path),
        "jams_duration_seconds": float(payload["file_metadata"]["duration"]),
        "bytes": path.stat().st_size,
    }


def recording_entry(recording_id: str) -> dict:
    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    annotation = ANNOTATION_DIR / f"{recording_id}.jams"
    if not audio.is_file() or not annotation.is_file():
        raise SystemExit(f"missing pinned recording {recording_id}")
    return {
        "identity": parse_recording_id(recording_id),
        "audio": wav_facts(audio),
        "annotation": annotation_facts(annotation),
    }


def build_manifest() -> dict:
    assert_split_integrity()
    if not SOURCE_AUDIO_ZIP.is_file() or not SOURCE_ANNOTATION_ZIP.is_file():
        raise SystemExit("official GuitarSet archives are not available")
    blstm = list(MADMOM_MODELS.glob("beats_blstm_[1-8].pkl"))
    if len(blstm) != 8:
        raise SystemExit(f"expected 8 Madmom BLSTM beat files, found {len(blstm)}")
    weights = list(CHORD_WEIGHTS.glob("joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s*.best.sdict"))
    if len(weights) != 5:
        raise SystemExit(f"expected 5 chord weight files, found {len(weights)}")
    return {
        "phase": "BACKEND-04K",
        "pre_registration": "Written before model inference. Selection and metric text are fixed here.",
        "dataset": {
            "name": "GuitarSet",
            "version": "1.1.0",
            "doi": "10.5281/zenodo.3371780",
            "license": "Creative Commons Attribution 4.0 International",
            "audio_archive_md5": "275966d6610ac34999b58426beb119c3",
            "annotation_archive_md5": "b39b78e63d3446f2e54ddb7a54df9b10",
            "annotation_archive_sha256": "8daa02e6417ccca1685feb44b135e95928ad7037e5032ecb326b5791856fda99",
            "local_audio_archive_md5": None,
            "local_annotation_archive_md5": None,
        },
        "split": {
            "diagnostic_ids": list(DIAGNOSTIC_IDS),
            "development_ids": list(DEVELOPMENT_IDS),
            "locked_test_ids": list(LOCKED_TEST_IDS),
            "errata_excluded": list(ERRATA_IDS),
            "development_count_after_errata": len(DEVELOPMENT_IDS),
            "locked_test_count_after_errata": len(LOCKED_TEST_IDS),
            "errata_inside_scored_splits": [],
        },
        "metric_contract": METRIC_CONTRACT,
        "detector_config": DETECTOR_CONFIG,
        "model_files": {
            "madmom_blstm_2015_sha256": file_sha_map(blstm),
            "chord_cnn_lstm_sdict_sha256": file_sha_map(weights),
            "config_sha256": {str(path.relative_to(BACKEND_ROOT)): sha256(path) for path in CONFIG_FILES},
        },
        "recordings": {
            recording_id: recording_entry(recording_id)
            for recording_id in (*DIAGNOSTIC_IDS, *DEVELOPMENT_IDS, *LOCKED_TEST_IDS)
        },
        "runtime_pin_note": "Python, torch, and madmom versions are recorded at seal time and checked again at run time.",
        "runtime": runtime_versions(),
    }


def runtime_versions() -> dict:
    versions = {"python": platform.python_version(), "platform": platform.platform()}
    try:
        import madmom
        versions["madmom"] = getattr(madmom, "__version__", "unknown")
    except ImportError:
        versions["madmom"] = "UNAVAILABLE"
    try:
        import torch
        versions["torch"] = torch.__version__
    except ImportError:
        versions["torch"] = "UNAVAILABLE"
    return versions


def md5_file(path: Path) -> str:
    digest_md5 = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest_md5.update(chunk)
    return digest_md5.hexdigest()


def seal_manifest() -> int:
    manifest = build_manifest()
    manifest["dataset"]["local_audio_archive_md5"] = md5_file(SOURCE_AUDIO_ZIP)
    manifest["dataset"]["local_annotation_archive_md5"] = md5_file(SOURCE_ANNOTATION_ZIP)
    if manifest["dataset"]["local_audio_archive_md5"] != manifest["dataset"]["audio_archive_md5"]:
        raise SystemExit("audio archive checksum mismatch")
    if manifest["dataset"]["local_annotation_archive_md5"] != manifest["dataset"]["annotation_archive_md5"]:
        raise SystemExit("annotation archive checksum mismatch")
    MANIFEST_PATH.write_bytes(canonical(manifest))
    manifest_sha = hashlib.sha256(MANIFEST_PATH.read_bytes()).hexdigest()
    MANIFEST_SHA_PATH.write_text(manifest_sha + "\n", encoding="utf-8")
    print(f"manifest={MANIFEST_PATH}")
    print(f"manifest_sha256={manifest_sha}")
    print(f"development={len(DEVELOPMENT_IDS)} locked={len(LOCKED_TEST_IDS)} diagnostic={len(DIAGNOSTIC_IDS)}")
    return 0


def load_sealed_manifest() -> dict:
    if not MANIFEST_PATH.is_file() or not MANIFEST_SHA_PATH.is_file():
        raise SystemExit("sealed manifest is missing")
    raw = MANIFEST_PATH.read_bytes()
    expected = MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise SystemExit("manifest bytes changed after pre-registration")
    return json.loads(raw.decode("utf-8"))


def verify_manifest(manifest: dict) -> None:
    assert_split_integrity()
    if manifest["metric_contract"] != METRIC_CONTRACT:
        raise SystemExit("metric contract drifted from the sealed manifest")
    if manifest["detector_config"] != DETECTOR_CONFIG:
        raise SystemExit("detector config drifted from the sealed manifest")
    if manifest["split"]["development_ids"] != list(DEVELOPMENT_IDS) or manifest["split"]["locked_test_ids"] != list(LOCKED_TEST_IDS):
        raise SystemExit("split ids drifted from the sealed manifest")
    for recording_id, entry in manifest["recordings"].items():
        audio = AUDIO_DIR / f"{recording_id}_mic.wav"
        annotation = ANNOTATION_DIR / f"{recording_id}.jams"
        if sha256(audio) != entry["audio"]["sha256"] or sha256(annotation) != entry["annotation"]["sha256"]:
            raise SystemExit(f"hash mismatch for {recording_id}")
    for name, expected in manifest["model_files"]["madmom_blstm_2015_sha256"].items():
        if sha256(MADMOM_MODELS / name) != expected:
            raise SystemExit(f"Madmom weight changed: {name}")
    for name, expected in manifest["model_files"]["chord_cnn_lstm_sdict_sha256"].items():
        if sha256(CHORD_WEIGHTS / name) != expected:
            raise SystemExit(f"chord weight changed: {name}")
    for relative, expected in manifest["model_files"]["config_sha256"].items():
        if sha256(BACKEND_ROOT / relative) != expected:
            raise SystemExit(f"detector source changed: {relative}")
    if runtime_versions() != manifest["runtime"]:
        raise SystemExit("runtime versions changed after the seal")


def load_checkpoint() -> dict:
    if not CHECKPOINT_PATH.is_file():
        return {}
    return json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))


def save_checkpoint(rows: dict) -> None:
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT_PATH.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def evaluate_one(services, vocabulary: set, recording_id: str) -> dict:
    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    annotation = ANNOTATION_DIR / f"{recording_id}.jams"
    identity = parse_recording_id(recording_id)
    jams = load_jams(annotation)
    layers = chord_layers(jams)
    lead = rows_to_segments(layers["lead_sheet"]["data"])
    beats = beat_reference(jams)
    probe = audio_probe(audio)
    scored = min(float(jams["file_metadata"]["duration"]), probe["duration_seconds"])
    beats_service, chord_service = services
    started = time.perf_counter()
    beat_result = beats_service.detect_beats(str(audio), detector="madmom", force=False)
    beat_seconds = time.perf_counter() - started
    started = time.perf_counter()
    chord_result = chord_service.recognize_chords(
        str(audio),
        detector="chord-cnn-lstm",
        chord_dict="submission",
        force=False,
        use_spleeter=False,
    )
    chord_seconds = time.perf_counter() - started
    if beat_result.get("model_used") != "madmom" or not beat_result.get("success"):
        raise SystemExit(f"{recording_id} beat model failed")
    if chord_result.get("model_used") != "chord-cnn-lstm" or not chord_result.get("success"):
        raise SystemExit(f"{recording_id} chord model failed")
    if chord_result.get("chord_dict") not in (None, "submission"):
        raise SystemExit(f"{recording_id} chord dictionary drifted")
    predicted = predicted_segments(chord_result)
    detected = [float(value) for value in (beat_result.get("beats") or [])]
    reference_beats = [instant for instant in beats["beats"] if instant <= scored + 1e-6]
    vocabulary_time = 0.0
    for segment in lead:
        width = min(segment["end"], scored) - max(segment["start"], 0.0)
        if width > 0 and in_submission_vocabulary(segment["chord"], vocabulary):
            vocabulary_time += width
    tempo = beats["tempo_events"][0]["bpm"] if len(beats["tempo_events"]) == 1 else None
    metrics = score_recording(lead, predicted, reference_beats, detected, tempo, scored, vocabulary_time)
    metrics["bpm_detected"] = beat_result.get("bpm")
    metrics["bpm_error"] = None if tempo is None or beat_result.get("bpm") is None else round(abs(float(beat_result["bpm"]) - tempo), 6)
    confusion = []
    # Development inspection is allowed. Locked-test callers discard this list
    # from the open evidence and keep it only inside the seal.
    from backend_04i_guitarset_eval import time_slices as slice_pairs
    pairs = slice_pairs(lead, predicted, scored)["pairs"]
    ranked = sorted(pairs.items(), key=lambda item: item[1], reverse=True)
    for (expected, predicted_label), width in ranked:
        if expected != predicted_label:
            confusion.append({"reference": expected, "predicted": predicted_label, "seconds": round(width, 6)})
        if len(confusion) == 8:
            break
    return {
        "id": recording_id,
        "style_code": identity["style_code"],
        "player": identity["player"],
        "progression": identity["progression"],
        "filename_bpm": identity["filename_bpm"],
        "scored_duration_seconds": round(scored, 6),
        "audio_sha256": sha256(audio),
        "annotation_sha256": sha256(annotation),
        "beat_wall_seconds": round(beat_seconds, 4),
        "chord_wall_seconds": round(chord_seconds, 4),
        "combined_wall_seconds": round(beat_seconds + chord_seconds, 4),
        "real_time_factor": round((beat_seconds + chord_seconds) / scored, 4) if scored else None,
        "metrics": metrics,
        "confusion_examples": confusion,
        "model_used": {"beats": beat_result.get("model_used"), "chords": chord_result.get("model_used")},
        "beats": slim(beat_result),
        "chords": slim(chord_result),
        "peak_memory_mb": round(peak_mb(), 2),
    }


def public_recording(item: dict, include_examples: bool) -> dict:
    payload = {key: value for key, value in item.items() if key != "confusion_examples"}
    if include_examples:
        payload["confusion_examples"] = item["confusion_examples"]
    return payload


def compare_diagnostic(item: dict) -> dict:
    prior = json.loads(PRIOR_EVIDENCE_PATH.read_text(encoding="utf-8"))
    previous = next(row for row in prior["recordings"] if row["id"] == item["id"])
    checks = {
        "exact_accuracy": (item["metrics"]["exact_accuracy"], previous["metrics"]["lead_sheet"]["exact_accuracy"]),
        "enharmonic_shorthand_accuracy": (
            item["metrics"]["enharmonic_shorthand_accuracy"],
            previous["metrics"]["lead_sheet"]["enharmonic_shorthand_accuracy"],
        ),
        "root_accuracy": (item["metrics"]["root_accuracy"], previous["metrics"]["lead_sheet"]["root_accuracy"]),
        "bare_triad_recall": (item["metrics"]["bare_triad_recall"], previous["metrics"]["lead_sheet"]["major_minor_accuracy"]),
        "greedy_beat_f_measure": (
            item["metrics"]["beats"]["greedy"]["f_measure"],
            previous["metrics"]["beats"]["f_measure"],
        ),
        "bpm_error": (item["metrics"]["bpm_error"], previous["metrics"]["bpm_error"]),
    }
    deltas = {name: None if left is None or right is None else round(abs(left - right), 6) for name, (left, right) in checks.items()}
    return {"id": item["id"], "deltas": deltas, "within_1e-4": all(value is not None and value <= 1e-4 for value in deltas.values())}


def free_port() -> int:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    return port


def spotcheck_flask(audio: Path) -> dict:
    secret = secrets.token_hex(32)
    port = free_port()
    child = subprocess.Popen(
        [sys.executable, str(RESEARCH_DIR / "serve_localhost_inference.py"), str(port)],
        cwd=str(BACKEND_ROOT),
        env={**os.environ, "TESTING": "1", "CHORDMINI_INFERENCE_AUTH": "required", "CHORDMINI_INFERENCE_SECRET": secret},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 120
        ready = False
        while time.time() < deadline:
            if child.poll() is not None:
                return {"accepted": False, "reason": "flask exited"}
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                connection.request("GET", "/health")
                response = connection.getresponse()
                response.read()
                connection.close()
                if response.status == 200:
                    ready = True
                    break
            except OSError:
                time.sleep(0.4)
        if not ready:
            return {"accepted": False, "reason": "health timeout"}
        boundary = "----chordmini04k"
        body_parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"detector\"\r\n\r\nmadmom\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{audio.name}\"\r\nContent-Type: audio/wav\r\n\r\n".encode(),
            audio.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        payload = b"".join(body_parts)
        denied = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        denied.request("POST", "/api/detect-beats", body=payload, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(payload)),
        })
        denied_response = denied.getresponse()
        denied_response.read()
        denied.close()
        allowed = http.client.HTTPConnection("127.0.0.1", port, timeout=180)
        started = time.perf_counter()
        allowed.request("POST", "/api/detect-beats", body=payload, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(payload)),
            "X-ChordMini-Inference-Token": secret,
        })
        allowed_response = allowed.getresponse()
        raw = allowed_response.read()
        elapsed = time.perf_counter() - started
        allowed.close()
        parsed = json.loads(raw.decode("utf-8"))
        if secret in json.dumps(parsed):
            raise SystemExit("flask response contained the credential")
        return {
            "recording_id": audio.name.replace("_mic.wav", ""),
            "split": "development",
            "tokenless_status": denied_response.status,
            "beat_status": allowed_response.status,
            "beat_model": parsed.get("model_used"),
            "beat_success": parsed.get("success"),
            "beat_seconds": round(elapsed, 4),
            "firebase_identity": "NOT_USED_ON_THIS_DIRECT_FLASK_PATH",
        }
    finally:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()


def run_baseline() -> int:
    os.environ.setdefault("TESTING", "1")
    manifest = load_sealed_manifest()
    verify_manifest(manifest)
    vocabulary = load_submission_labels()
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    services = (BeatDetectionService(), ChordRecognitionService())
    checkpoint = load_checkpoint()
    order = [*DIAGNOSTIC_IDS, *DEVELOPMENT_IDS, *LOCKED_TEST_IDS]
    for recording_id in order:
        if recording_id in checkpoint:
            continue
        print(f"scoring {recording_id}", flush=True)
        checkpoint[recording_id] = evaluate_one(services, vocabulary, recording_id)
        save_checkpoint(checkpoint)
    missing = [recording_id for recording_id in order if recording_id not in checkpoint]
    if missing:
        raise SystemExit("checkpoint is incomplete")
    diagnostic = [checkpoint[recording_id] for recording_id in DIAGNOSTIC_IDS]
    development = [checkpoint[recording_id] for recording_id in DEVELOPMENT_IDS]
    locked = [checkpoint[recording_id] for recording_id in LOCKED_TEST_IDS]
    reproduction = [compare_diagnostic(item) for item in diagnostic]
    locked_seal = {
        "phase": "BACKEND-04K",
        "role": "Locked-test per-recording baseline. Do not use these outputs to choose a parameter.",
        "runs": 1,
        "recordings": [public_recording(item, include_examples=True) for item in locked],
        "aggregate": aggregate_recordings(locked),
        "by_style": aggregate_by_style(locked),
    }
    SEAL_PATH.write_bytes(canonical(locked_seal))
    seal_sha = hashlib.sha256(SEAL_PATH.read_bytes()).hexdigest()
    walls = diagnostic + development + locked
    cold = diagnostic[0]
    warm = [item for item in walls if item["id"] != cold["id"]]
    warm_seconds = round(sum(item["combined_wall_seconds"] for item in warm), 4)
    warm_duration = sum(item["scored_duration_seconds"] for item in warm)
    flask = spotcheck_flask(AUDIO_DIR / f"{DEVELOPMENT_IDS[0]}_mic.wav")
    evidence = {
        "phase": "BACKEND-04K",
        "manifest_sha256": MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip(),
        "model_config_integrity": "MATCH",
        "model_changed": False,
        "cpu": cpu_info(),
        "runtime": runtime_versions(),
        "diagnostic_reproduction": {
            "compared_with": "python_backend/research/backend_04i_guitarset_evidence.json",
            "tolerance": 1e-4,
            "recordings": reproduction,
            "all_within_tolerance": all(item["within_1e-4"] for item in reproduction),
        },
        "development": {
            "count": len(development),
            "aggregate": aggregate_recordings(development),
            "by_style": aggregate_by_style(development),
            "recordings": [public_recording(item, include_examples=True) for item in development],
        },
        "locked_test": {
            "count": len(locked),
            "runs": 1,
            "used_for_parameter_selection": False,
            "aggregate": aggregate_recordings(locked),
            "by_style": aggregate_by_style(locked),
            "seal_file": SEAL_PATH.name,
            "seal_sha256": seal_sha,
            "per_recording_outputs": "stored only in the seal file",
        },
        "performance": {
            "recordings": len(walls),
            "scored_duration_seconds": round(sum(item["scored_duration_seconds"] for item in walls), 6),
            "cold_recording_id": cold["id"],
            "cold_combined_seconds": cold["combined_wall_seconds"],
            "cold_beat_seconds": cold["beat_wall_seconds"],
            "cold_chord_seconds": cold["chord_wall_seconds"],
            "warm_combined_seconds": warm_seconds,
            "warm_scored_duration_seconds": round(warm_duration, 6),
            "warm_real_time_factor": round(warm_seconds / warm_duration, 4) if warm_duration else None,
            "combined_real_time_factor": round(sum(item["combined_wall_seconds"] for item in walls) / sum(item["scored_duration_seconds"] for item in walls), 4),
            "peak_memory_mb": round(peak_mb(), 2),
            "failures": 0,
            "timeouts": 0,
        },
        "flask_development_spotcheck": flask,
        "evaluation_failures": [],
    }
    if not evidence["diagnostic_reproduction"]["all_within_tolerance"]:
        evidence["evaluation_failures"].append("diagnostic reproduction exceeded 1e-4")
    if flask.get("tokenless_status") != 401 or flask.get("beat_model") != "madmom":
        evidence["evaluation_failures"].append("development flask spotcheck")
    EVIDENCE_PATH.write_bytes(canonical(evidence))
    print(f"evidence={EVIDENCE_PATH}")
    print(f"locked_seal_sha256={seal_sha}")
    print(f"diagnostic_reproduction={evidence['diagnostic_reproduction']['all_within_tolerance']}")
    print(f"development={evidence['development']['aggregate']}")
    print(f"locked_aggregate={evidence['locked_test']['aggregate']}")
    print(f"performance={evidence['performance']}")
    if evidence["evaluation_failures"]:
        print("failures=" + ",".join(evidence["evaluation_failures"]))
        return 1
    print("baseline=PASS")
    return 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--seal":
        return seal_manifest()
    if len(sys.argv) == 2 and sys.argv[1] == "--run":
        return run_baseline()
    print("usage: backend_04k_sealed_baseline.py --seal|--run", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
