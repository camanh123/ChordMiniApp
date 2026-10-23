"""BACKEND-04L Madmom correction ablation.

The production detector is not imported and is not modified. This script builds
two research trackers from one RNN activation. Control uses correct=True.
Treatment uses correct=False. Chord-CNN-LSTM is not called.

`--seal` writes the manifest before inference. `--development` scores the 40
development recordings. `--locked` runs the treatment once, and only after the
recorded development gate passes. Diagnostic excerpts are not scored.
"""

import hashlib
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

RESEARCH_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = RESEARCH_DIR.parent
REPO_ROOT = BACKEND_ROOT.parent
if str(RESEARCH_DIR) not in sys.path:
    sys.path.insert(0, str(RESEARCH_DIR))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from backend_04i_guitarset_eval import (  # noqa: E402
    audio_probe,
    beat_reference,
    cpu_info,
    load_jams,
    peak_mb,
    sha256,
)
from backend_04k_metrics import (  # noqa: E402
    DEVELOPMENT_IDS,
    DIAGNOSTIC_IDS,
    LOCKED_TEST_IDS,
    parse_recording_id,
    score_beats,
)
from backend_04l_gate import (  # noqa: E402
    BASELINE_DURATION_WEIGHTED_BARE_TRIAD,
    BASELINE_DURATION_WEIGHTED_ROOT,
    BASELINE_MACRO_HALF_BEAT,
    BASELINE_MICRO_BEAT_F,
    BASELINE_STYLE_MICRO_F,
    CONTROL,
    LOCKED_BASELINE_MACRO_BEAT_F,
    LOCKED_BASELINE_MACRO_HALF_BEAT,
    LOCKED_BASELINE_MICRO_BEAT_F,
    PER_FILE_TIMEOUT_SECONDS,
    REPRESENTATIVE_RECORDING_ID,
    TREATMENT,
    acceptance_gate,
    aggregate_beats,
    aggregate_beats_by_style,
    budget_passed,
    candidate_decision,
    locked_regressed,
    locked_run_allowed,
)

BASELINE_HEAD = "c1254be40d0e063ed2c123f5e6ef696b363b18da"
PARENT_MANIFEST = RESEARCH_DIR / "backend_04k_manifest.json"
PARENT_MANIFEST_SHA = RESEARCH_DIR / "backend_04k_manifest.sha256"
PARENT_EVIDENCE = RESEARCH_DIR / "backend_04k_evidence.json"
PARENT_SEAL = RESEARCH_DIR / "backend_04k_locked_test_seal.json"
MANIFEST_PATH = RESEARCH_DIR / "backend_04l_manifest.json"
MANIFEST_SHA_PATH = RESEARCH_DIR / "backend_04l_manifest.sha256"
EVIDENCE_PATH = RESEARCH_DIR / "backend_04l_evidence.json"
DECISION_PATH = RESEARCH_DIR / "backend_04l_development_decision.json"
LOCKED_SEAL_PATH = RESEARCH_DIR / "backend_04l_locked_treatment_seal.json"
AUDIO_DIR = Path("/tmp/chordmini-04k/audio")
ANNOTATION_DIR = Path("/tmp/chordmini-04k/annotation")
CHECKPOINT_DIR = Path("/tmp/chordmini-04l")
MADMOM_MODELS = Path("/tmp/chordmini-bt02-venv/lib/python3.10/site-packages/madmom/models/beats/2015")
CHORD_WEIGHTS = BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "cache_data"
ALLOWED_PATHS = {
    "python_backend/research/backend_04l_gate.py",
    "python_backend/research/backend_04l_correction_ablation.py",
    "python_backend/research/backend_04l_manifest.json",
    "python_backend/research/backend_04l_manifest.sha256",
    "python_backend/research/backend_04l_evidence.json",
    "python_backend/research/backend_04l_development_decision.json",
    "python_backend/research/backend_04l_locked_treatment_seal.json",
    "python_backend/tests/test_backend_04l_gate.py",
    ".gitignore",
}
BEAT_COMPARE_KEYS = (
    "micro_beat_precision",
    "micro_beat_recall",
    "micro_beat_f_measure",
    "macro_beat_f_measure",
    "macro_half_beat_fraction",
    "macro_bpm_error",
    "extra_beats",
    "missed_beats",
    "greedy_assumption_failures",
)


def canonical(payload: dict) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def digest(payload: dict) -> str:
    return hashlib.sha256(canonical(payload)).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_output(args: list) -> str:
    return subprocess.check_output(["git", *args], cwd=str(REPO_ROOT), text=True)


def changed_paths() -> list:
    tracked = [line for line in git_output(["diff", "--name-only", BASELINE_HEAD]).splitlines() if line]
    untracked = [line for line in git_output(["ls-files", "--others", "--exclude-standard"]).splitlines() if line]
    return sorted(set(tracked + untracked))


def assert_worktree_scope() -> None:
    unexpected = [path for path in changed_paths() if path not in ALLOWED_PATHS]
    if unexpected:
        raise SystemExit("frozen path changed: " + ", ".join(unexpected))
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", BASELINE_HEAD, "HEAD"],
        cwd=str(REPO_ROOT),
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit("baseline commit is not an ancestor")


def runtime_versions() -> dict:
    import madmom
    import torch

    return {
        "madmom": madmom.__version__,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "torch": torch.__version__,
    }


def load_parent() -> tuple:
    manifest_bytes = PARENT_MANIFEST.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != PARENT_MANIFEST_SHA.read_text(encoding="utf-8").strip():
        raise SystemExit("BACKEND-04K manifest hash mismatch")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    evidence = json.loads(PARENT_EVIDENCE.read_text(encoding="utf-8"))
    if hashlib.sha256(PARENT_SEAL.read_bytes()).hexdigest() != evidence["locked_test"]["seal_sha256"]:
        raise SystemExit("BACKEND-04K locked seal hash mismatch")
    return manifest, evidence


def assert_model_hashes(manifest: dict) -> None:
    for name, expected in manifest["model_files"]["madmom_blstm_2015_sha256"].items():
        if sha256(MADMOM_MODELS / name) != expected:
            raise SystemExit(f"Madmom weight changed: {name}")
    for name, expected in manifest["model_files"]["chord_cnn_lstm_sdict_sha256"].items():
        if sha256(CHORD_WEIGHTS / name) != expected:
            raise SystemExit(f"chord weight changed: {name}")
    for relative, expected in manifest["model_files"]["config_sha256"].items():
        if sha256(BACKEND_ROOT / relative) != expected:
            raise SystemExit(f"detector source changed: {relative}")


def assert_audio_hash(manifest: dict, recording_id: str) -> None:
    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    annotation = ANNOTATION_DIR / f"{recording_id}.jams"
    entry = manifest["recordings"][recording_id]
    if sha256(audio) != entry["audio"]["sha256"] or sha256(annotation) != entry["annotation"]["sha256"]:
        raise SystemExit(f"hash mismatch for {recording_id}")


def detected_bpm(beat_times: list) -> float:
    import numpy as np

    bpm = 120.0
    if len(beat_times) > 1:
        median_interval = float(np.median(np.diff(np.asarray(beat_times, dtype=float))))
        bpm = 60.0 / median_interval if median_interval > 0 else 120.0
    return float(bpm)


def score_detected(recording_id: str, detected: list) -> dict:
    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    jams = load_jams(ANNOTATION_DIR / f"{recording_id}.jams")
    reference = beat_reference(jams)
    scored = min(float(jams["file_metadata"]["duration"]), audio_probe(audio)["duration_seconds"])
    reference_beats = [instant for instant in reference["beats"] if instant <= scored + 1e-6]
    tempo = reference["tempo_events"][0]["bpm"] if len(reference["tempo_events"]) == 1 else None
    beats = score_beats(reference_beats, detected, tempo)
    bpm = detected_bpm(detected)
    return {
        "id": recording_id,
        "style_code": parse_recording_id(recording_id)["style_code"],
        "scored_duration_seconds": round(scored, 6),
        "official": beats["official"],
        "half_beat_fraction": (beats.get("phase") or {}).get("fraction_near_half_beat"),
        "bpm_error": None if tempo is None else round(abs(bpm - tempo), 6),
        "bpm_detected": bpm,
        "assumption_holds": beats["assumption_holds"],
        "detected_min_gap_seconds": beats["detected_min_gap_seconds"],
        "reference_min_gap_seconds": beats["reference_min_gap_seconds"],
        "greedy_f_measure": beats["greedy"]["f_measure"],
        "optimal_f_measure": beats["optimal"]["f_measure"],
        "beat_times": [round(float(value), 6) for value in detected],
    }


def stored_rows(evidence: dict) -> list:
    rows = []
    for item in evidence["development"]["recordings"]:
        phase = item["metrics"]["beats"].get("phase") or {}
        rows.append({
            "id": item["id"],
            "style_code": item["style_code"],
            "official": item["metrics"]["beats"]["official"],
            "half_beat_fraction": phase.get("fraction_near_half_beat"),
            "bpm_error": item["metrics"].get("bpm_error"),
            "assumption_holds": item["metrics"]["beats"]["assumption_holds"],
            "beat_times": [float(value) for value in item["beats"]["beats"]],
            "bpm_detected": float(item["beats"]["bpm"]),
        })
    return rows


def values_match(left: dict, right: dict) -> bool:
    for key in BEAT_COMPARE_KEYS:
        if left[key] != right[key]:
            return False
    return True


def seal_manifest() -> None:
    assert_worktree_scope()
    parent_manifest, evidence = load_parent()
    assert_model_hashes(parent_manifest)
    runtime = runtime_versions()
    if runtime != parent_manifest["runtime"]:
        raise SystemExit("runtime drifted from the BACKEND-04K manifest")
    development = evidence["development"]
    if round(development["aggregate"]["micro_beat_f_measure"], 6) != round(BASELINE_MICRO_BEAT_F, 6):
        raise SystemExit("development baseline F drifted")
    if development["aggregate"]["macro_half_beat_fraction"] != BASELINE_MACRO_HALF_BEAT:
        raise SystemExit("development half-beat baseline drifted")
    for style, expected in BASELINE_STYLE_MICRO_F.items():
        if round(development["by_style"][style]["micro_beat_f_measure"], 6) != round(expected, 6):
            raise SystemExit(f"style baseline drifted: {style}")
    if development["aggregate"]["duration_weighted_root_accuracy"] != BASELINE_DURATION_WEIGHTED_ROOT:
        raise SystemExit("chord root baseline drifted")
    if development["aggregate"]["duration_weighted_bare_triad_recall"] != BASELINE_DURATION_WEIGHTED_BARE_TRIAD:
        raise SystemExit("bare-triad baseline drifted")
    locked = evidence["locked_test"]["aggregate"]
    if locked["micro_beat_f_measure"] != LOCKED_BASELINE_MICRO_BEAT_F or locked["macro_beat_f_measure"] != LOCKED_BASELINE_MACRO_BEAT_F:
        raise SystemExit("locked aggregate pin drifted")
    if locked["macro_half_beat_fraction"] != LOCKED_BASELINE_MACRO_HALF_BEAT:
        raise SystemExit("locked half-beat pin drifted")
    if REPRESENTATIVE_RECORDING_ID not in DEVELOPMENT_IDS:
        raise SystemExit("representative recording is outside development")
    manifest = {
        "phase": "BACKEND-04L",
        "parent_head": BASELINE_HEAD,
        "parent_manifest_sha256": PARENT_MANIFEST_SHA.read_text(encoding="utf-8").strip(),
        "parent_evidence_sha256": hashlib.sha256(PARENT_EVIDENCE.read_bytes()).hexdigest(),
        "parent_locked_seal_sha256": hashlib.sha256(PARENT_SEAL.read_bytes()).hexdigest(),
        "dataset": parent_manifest["dataset"],
        "split": parent_manifest["split"],
        "control": CONTROL,
        "treatment": TREATMENT,
        "unchanged": [
            "RNNBeatProcessor",
            "Madmom BLSTM weights",
            "Chord-CNN-LSTM weights and decoder",
            "audio preprocessing",
            "70 ms beat matcher and BACKEND-04K aggregation",
            "downbeat heuristics",
            "BPM from the median inter-beat interval, default 120",
            "production DBNBeatTrackingProcessor(fps=100) with correct=True",
        ],
        "gate": {
            "baseline_micro_beat_f": BASELINE_MICRO_BEAT_F,
            "treatment_micro_beat_f_minimum": 0.809300,
            "baseline_macro_half_beat": BASELINE_MACRO_HALF_BEAT,
            "treatment_macro_half_beat_maximum_exclusive": BASELINE_MACRO_HALF_BEAT,
            "style_micro_f_drop_limit": 0.05,
            "style_baseline_micro_f": BASELINE_STYLE_MICRO_F,
            "chord_tolerance": 1e-4,
            "chord_inference": "not invoked; root and bare-triad deltas must stay within 1e-4 of zero",
            "control_reproduction_tolerance_seconds": 1e-6,
            "locked_rule": "Run the treatment once only after control integrity and the development acceptance gate pass. Reject if locked micro beat F is below the sealed aggregate by more than 1e-4.",
            "locked_baseline_micro_beat_f": LOCKED_BASELINE_MICRO_BEAT_F,
            "locked_baseline_macro_beat_f": LOCKED_BASELINE_MACRO_BEAT_F,
            "locked_baseline_macro_half_beat": LOCKED_BASELINE_MACRO_HALF_BEAT,
            "keep_rule": "KEEP only when the development gate passes, the warm treatment-path real-time factor is at most 0.20, representative and overall peak RSS are at most 1200 MB, and the single locked run does not regress micro beat F. KEEP does not authorize a production change.",
        },
        "representative_recording_id": REPRESENTATIVE_RECORDING_ID,
        "representative_duration_seconds": parent_manifest["recordings"][REPRESENTATIVE_RECORDING_ID]["audio"]["duration_seconds"],
        "development_order": [REPRESENTATIVE_RECORDING_ID, *[recording_id for recording_id in DEVELOPMENT_IDS if recording_id != REPRESENTATIVE_RECORDING_ID]],
        "model_files": parent_manifest["model_files"],
        "runtime": runtime,
        "performance_budget": {"warm_treatment_path_rtf_maximum": 0.20, "peak_rss_mb_maximum": 1200, "per_file_timeout_seconds": PER_FILE_TIMEOUT_SECONDS},
        "diagnostic_ids_excluded": list(DIAGNOSTIC_IDS),
        "production_integration": False,
    }
    if len(manifest["development_order"]) != 40 or len(set(manifest["development_order"])) != 40:
        raise SystemExit("development order is not the sealed 40-file split")
    payload = canonical(manifest)
    MANIFEST_PATH.write_bytes(payload)
    MANIFEST_SHA_PATH.write_text(hashlib.sha256(payload).hexdigest() + "\n", encoding="utf-8")
    assert_worktree_scope()
    print(MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip())


def load_manifest() -> dict:
    payload = MANIFEST_PATH.read_bytes()
    if hashlib.sha256(payload).hexdigest() != MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip():
        raise SystemExit("BACKEND-04L manifest hash mismatch")
    manifest = json.loads(payload.decode("utf-8"))
    if manifest["control"] != CONTROL or manifest["treatment"] != TREATMENT:
        raise SystemExit("tracker configuration drifted from the sealed manifest")
    if manifest["gate"]["treatment_micro_beat_f_minimum"] != 0.809300:
        raise SystemExit("acceptance threshold drifted")
    if manifest["gate"]["treatment_macro_half_beat_maximum_exclusive"] != BASELINE_MACRO_HALF_BEAT:
        raise SystemExit("half-beat threshold drifted")
    return manifest


def make_trackers():
    from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor

    processor = DBNBeatTrackingProcessor
    defaults = {
        "min_bpm": processor.MIN_BPM,
        "max_bpm": processor.MAX_BPM,
        "transition_lambda": processor.TRANSITION_LAMBDA,
        "observation_lambda": processor.OBSERVATION_LAMBDA,
        "correct": processor.CORRECT,
        "threshold": processor.THRESHOLD,
        "num_tempi": processor.NUM_TEMPI,
    }
    for key, value in defaults.items():
        if value != CONTROL[key]:
            raise SystemExit(f"installed Madmom default drifted: {key}")
    common = {
        "fps": 100,
        "min_bpm": 55.0,
        "max_bpm": 215.0,
        "transition_lambda": 100,
        "observation_lambda": 16,
        "threshold": 0,
        "num_tempi": None,
    }
    started = time.perf_counter()
    rnn = RNNBeatProcessor()
    control = DBNBeatTrackingProcessor(correct=True, **common)
    treatment = DBNBeatTrackingProcessor(correct=False, **common)
    if control.correct is not True or treatment.correct is not False:
        raise SystemExit("tracker correction flag was not isolated")
    if control.min_bpm != treatment.min_bpm or control.max_bpm != treatment.max_bpm or control.fps != treatment.fps:
        raise SystemExit("tracker bounds drifted between control and treatment")
    return rnn, control, treatment, round(time.perf_counter() - started, 4)


def decode_treatment(rnn, treatment, recording_id: str) -> dict:
    import numpy as np

    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    started = time.perf_counter()
    activations = np.asarray(rnn(str(audio)), dtype=float)
    rnn_seconds = time.perf_counter() - started
    treatment.reset()
    started = time.perf_counter()
    treatment_times = [float(value) for value in treatment(np.array(activations, copy=True))]
    treatment_seconds = time.perf_counter() - started
    return {
        "treatment_times": treatment_times,
        "rnn_seconds": round(rnn_seconds, 4),
        "treatment_seconds": round(treatment_seconds, 4),
        "treatment_path_seconds": round(rnn_seconds + treatment_seconds, 4),
        "combined_seconds": round(rnn_seconds + treatment_seconds, 4),
    }


def decode_pair(rnn, control, treatment, recording_id: str) -> dict:
    import numpy as np

    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    started = time.perf_counter()
    activations = np.asarray(rnn(str(audio)), dtype=float)
    rnn_seconds = time.perf_counter() - started
    control.reset()
    started = time.perf_counter()
    control_times = [float(value) for value in control(np.array(activations, copy=True))]
    control_seconds = time.perf_counter() - started
    treatment.reset()
    started = time.perf_counter()
    treatment_times = [float(value) for value in treatment(np.array(activations, copy=True))]
    treatment_seconds = time.perf_counter() - started
    return {
        "control_times": control_times,
        "treatment_times": treatment_times,
        "rnn_seconds": round(rnn_seconds, 4),
        "control_seconds": round(control_seconds, 4),
        "treatment_seconds": round(treatment_seconds, 4),
        "combined_seconds": round(rnn_seconds + control_seconds + treatment_seconds, 4),
        "treatment_path_seconds": round(rnn_seconds + treatment_seconds, 4),
    }


def checkpoint_path(name: str) -> Path:
    return CHECKPOINT_DIR / name


def load_checkpoint(name: str, runner_hash: str) -> dict:
    path = checkpoint_path(name)
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("runner_sha256") != runner_hash:
        return {}
    return payload.get("rows") or {}


def save_checkpoint(name: str, runner_hash: str, rows: dict) -> None:
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    checkpoint_path(name).write_text(json.dumps({"runner_sha256": runner_hash, "rows": rows}, indent=2) + "\n", encoding="utf-8")


def public_beat_row(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "official"}


def run_development() -> None:
    assert_worktree_scope()
    manifest = load_manifest()
    parent_manifest, evidence = load_parent()
    assert_model_hashes(parent_manifest)
    if runtime_versions() != manifest["runtime"]:
        raise SystemExit("runtime drifted after the seal")
    if EVIDENCE_PATH.is_file():
        raise SystemExit("development evidence already exists")
    stored = {row["id"]: row for row in stored_rows(evidence)}
    reaggregated = aggregate_beats(list(stored.values()))
    if not values_match(reaggregated, evidence["development"]["aggregate"]):
        raise SystemExit("stored development beats do not reaggregate to the sealed baseline")
    order = manifest["development_order"]
    runner_hash = file_digest(Path(__file__))
    completed = load_checkpoint("development.json", runner_hash)
    rnn, control, treatment, init_seconds = make_trackers()
    rows = []
    mismatches = []
    timeouts = 0
    for index, recording_id in enumerate(order):
        assert_audio_hash(parent_manifest, recording_id)
        if recording_id in completed:
            decoded = completed[recording_id]
        else:
            decoded = decode_pair(rnn, control, treatment, recording_id)
            if decoded["combined_seconds"] > PER_FILE_TIMEOUT_SECONDS:
                timeouts += 1
                raise SystemExit(f"timeout on {recording_id}")
            completed[recording_id] = decoded
            save_checkpoint("development.json", runner_hash, completed)
        difference = None
        if len(decoded["control_times"]) == len(stored[recording_id]["beat_times"]):
            pairs = zip(decoded["control_times"], stored[recording_id]["beat_times"])
            difference = 0.0 if not decoded["control_times"] else max(abs(left - right) for left, right in pairs)
        control_score = score_detected(recording_id, decoded["control_times"])
        treatment_score = score_detected(recording_id, decoded["treatment_times"])
        bpm_delta = abs(control_score["bpm_detected"] - stored[recording_id]["bpm_detected"])
        if difference is None or difference > 1e-6 or bpm_delta > 1e-4:
            mismatches.append({"id": recording_id, "max_abs_seconds": difference, "bpm_delta": bpm_delta})
        rows.append({
            "id": recording_id,
            "style_code": treatment_score["style_code"],
            "scored_duration_seconds": treatment_score["scored_duration_seconds"],
            "cold": index == 0,
            "control_max_abs_seconds": difference,
            "control_bpm_delta": round(bpm_delta, 6),
            "timings": {key: decoded[key] for key in ("rnn_seconds", "control_seconds", "treatment_seconds", "combined_seconds", "treatment_path_seconds")},
            "control": control_score,
            "treatment": treatment_score,
            "peak_rss_mb": round(peak_mb(), 2),
        })
        print(f"development {index + 1}/40 {recording_id} {decoded['treatment_path_seconds']:.3f}s", flush=True)
    control_rows = [row["control"] for row in rows]
    treatment_rows = [row["treatment"] for row in rows]
    reproduced = aggregate_beats(control_rows)
    treated = aggregate_beats(treatment_rows)
    control_ok = not mismatches and values_match(reproduced, evidence["development"]["aggregate"])
    gate = acceptance_gate(
        treated["micro_beat_f_measure"],
        treated["macro_half_beat_fraction"],
        aggregate_beats_by_style(treatment_rows),
        0.0,
        0.0,
    )
    warm = [row for row in rows if not row["cold"]]
    warm_audio = sum(row["scored_duration_seconds"] for row in warm)
    warm_treatment = sum(row["timings"]["treatment_path_seconds"] for row in warm)
    warm_rtf = round(warm_treatment / warm_audio, 4) if warm_audio else None
    representative_peak = rows[0]["peak_rss_mb"]
    overall_peak = round(peak_mb(), 2)
    budget = budget_passed(warm_rtf, max(representative_peak, overall_peak))
    decision = {
        "control_integrity": control_ok,
        "acceptance_gate_passed": bool(control_ok and gate["passed"]),
        "budget_passed": budget,
        "gate": gate,
        "mismatches": mismatches,
    }
    payload = {
        "phase": "BACKEND-04L",
        "manifest_sha256": MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip(),
        "chord_inference_invoked": False,
        "chord_root_delta": 0.0,
        "chord_bare_triad_delta": 0.0,
        "chord_root_accuracy": BASELINE_DURATION_WEIGHTED_ROOT,
        "chord_bare_triad_recall": BASELINE_DURATION_WEIGHTED_BARE_TRIAD,
        "diagnostic_scored": False,
        "development": {
            "complete": True,
            "count": 40,
            "stored_baseline_micro_beat_f": BASELINE_MICRO_BEAT_F,
            "reproduced_control": reproduced,
            "reproduced_control_by_style": aggregate_beats_by_style(control_rows),
            "treatment": treated,
            "treatment_by_style": aggregate_beats_by_style(treatment_rows),
            "recordings": rows,
        },
        "decision": decision,
        "performance": {
            "cpu": cpu_info(),
            "cold_init_seconds": init_seconds,
            "cold_recording_id": rows[0]["id"],
            "cold_treatment_path_seconds": rows[0]["timings"]["treatment_path_seconds"],
            "cold_combined_seconds": round(init_seconds + rows[0]["timings"]["combined_seconds"], 4),
            "warm_treatment_path_seconds": round(warm_treatment, 4),
            "warm_audio_seconds": round(warm_audio, 6),
            "warm_treatment_path_real_time_factor": warm_rtf,
            "representative_peak_rss_mb": representative_peak,
            "peak_rss_mb": overall_peak,
            "failures": 0,
            "timeouts": timeouts,
        },
        "locked_test_executed": False,
    }
    EVIDENCE_PATH.write_bytes(canonical(payload))
    decision_record = {
        "control_integrity": decision["control_integrity"],
        "acceptance_gate_passed": decision["acceptance_gate_passed"],
        "budget_passed": decision["budget_passed"],
        "evidence_sha256": hashlib.sha256(EVIDENCE_PATH.read_bytes()).hexdigest(),
        "locked_run_allowed": locked_run_allowed(decision),
    }
    DECISION_PATH.write_bytes(canonical(decision_record))
    print("CONTROL_INTEGRITY", decision["control_integrity"])
    print("GATE_PASSED", decision["acceptance_gate_passed"])
    print("LOCKED_ALLOWED", decision_record["locked_run_allowed"])
    print("TREATMENT_MICRO_F", treated["micro_beat_f_measure"])
    print("TREATMENT_HALF", treated["macro_half_beat_fraction"])


def run_locked() -> None:
    assert_worktree_scope()
    if not DECISION_PATH.is_file() or not EVIDENCE_PATH.is_file():
        raise SystemExit("development decision is missing")
    decision = json.loads(DECISION_PATH.read_text(encoding="utf-8"))
    evidence_bytes = EVIDENCE_PATH.read_bytes()
    if hashlib.sha256(evidence_bytes).hexdigest() != decision["evidence_sha256"]:
        raise SystemExit("development evidence changed after the gate decision")
    if not locked_run_allowed(decision):
        raise SystemExit("locked treatment is refused because the development gate did not pass")
    evidence = json.loads(evidence_bytes.decode("utf-8"))
    if evidence.get("locked_test_executed") or evidence.get("locked_test", {}).get("runs") == 1:
        raise SystemExit("locked treatment was already run")
    manifest = load_manifest()
    parent_manifest, parent_evidence = load_parent()
    assert_model_hashes(parent_manifest)
    if runtime_versions() != manifest["runtime"]:
        raise SystemExit("runtime drifted after the seal")
    # The parent evidence is loaded for its sealed aggregate. Per-file locked
    # outputs live in the 04K seal and are not read here.
    locked_baseline = {
        "micro_beat_f_measure": parent_evidence["locked_test"]["aggregate"]["micro_beat_f_measure"],
        "macro_beat_f_measure": parent_evidence["locked_test"]["aggregate"]["macro_beat_f_measure"],
        "macro_half_beat_fraction": parent_evidence["locked_test"]["aggregate"]["macro_half_beat_fraction"],
        "macro_bpm_error": parent_evidence["locked_test"]["aggregate"]["macro_bpm_error"],
        "median_bpm_error": parent_evidence["locked_test"]["aggregate"]["median_bpm_error"],
        "duration_weighted_root_accuracy": parent_evidence["locked_test"]["aggregate"]["duration_weighted_root_accuracy"],
        "duration_weighted_bare_triad_recall": parent_evidence["locked_test"]["aggregate"]["duration_weighted_bare_triad_recall"],
    }
    del parent_evidence
    runner_hash = file_digest(Path(__file__))
    completed = load_checkpoint("locked.json", runner_hash)
    rnn, _control, treatment, init_seconds = make_trackers()
    del _control
    rows = []
    for index, recording_id in enumerate(LOCKED_TEST_IDS):
        assert_audio_hash(parent_manifest, recording_id)
        if recording_id not in completed:
            decoded = decode_treatment(rnn, treatment, recording_id)
            if decoded["combined_seconds"] > PER_FILE_TIMEOUT_SECONDS:
                raise SystemExit(f"timeout on locked recording {index}")
            completed[recording_id] = decoded
            save_checkpoint("locked.json", runner_hash, completed)
        treatment_score = score_detected(recording_id, completed[recording_id]["treatment_times"])
        rows.append({
            "id": recording_id,
            "style_code": treatment_score["style_code"],
            "scored_duration_seconds": treatment_score["scored_duration_seconds"],
            "timings": {key: completed[recording_id][key] for key in ("rnn_seconds", "treatment_seconds", "treatment_path_seconds", "combined_seconds")},
            "treatment": public_beat_row(treatment_score),
            "official": treatment_score,
            "peak_rss_mb": round(peak_mb(), 2),
        })
        print(f"locked {index + 1}/20", flush=True)
    treated = aggregate_beats([row["official"] for row in rows])
    by_style = aggregate_beats_by_style([row["official"] for row in rows])
    regression = locked_regressed(treated["micro_beat_f_measure"], locked_baseline["micro_beat_f_measure"])
    decision_for_candidate = {
        "control_integrity": decision["control_integrity"],
        "acceptance_gate_passed": decision["acceptance_gate_passed"],
        "budget_passed": decision["budget_passed"],
    }
    seal = {
        "role": "Per-file locked treatment outputs. Do not use these rows to choose a parameter or revise the gate.",
        "runs": 1,
        "aggregate": treated,
        "by_style": by_style,
        "recordings": [{key: value for key, value in row.items() if key != "official"} for row in rows],
    }
    LOCKED_SEAL_PATH.write_bytes(canonical(seal))
    warm = rows[1:]
    warm_audio = sum(row["scored_duration_seconds"] for row in warm)
    warm_treatment = sum(row["timings"]["treatment_path_seconds"] for row in warm)
    evidence["locked_test_executed"] = True
    evidence["locked_test"] = {
        "runs": 1,
        "used_for_parameter_selection": False,
        "seal_file": LOCKED_SEAL_PATH.name,
        "seal_sha256": hashlib.sha256(LOCKED_SEAL_PATH.read_bytes()).hexdigest(),
        "baseline": locked_baseline,
        "treatment": treated,
        "treatment_by_style": by_style,
        "micro_beat_f_delta": round(treated["micro_beat_f_measure"] - locked_baseline["micro_beat_f_measure"], 6),
        "regressed": regression,
        "chord_root_delta": 0.0,
        "chord_bare_triad_delta": 0.0,
        "performance": {
            "cold_init_seconds": init_seconds,
            "cold_treatment_path_seconds": rows[0]["timings"]["treatment_path_seconds"],
            "warm_treatment_path_seconds": round(warm_treatment, 4),
            "warm_audio_seconds": round(warm_audio, 6),
            "warm_treatment_path_real_time_factor": round(warm_treatment / warm_audio, 4) if warm_audio else None,
            "peak_rss_mb": round(peak_mb(), 2),
            "failures": 0,
            "timeouts": 0,
        },
    }
    evidence["candidate_decision"] = candidate_decision(decision_for_candidate, treated["micro_beat_f_measure"])
    EVIDENCE_PATH.write_bytes(canonical(evidence))
    print("LOCKED_REGRESSED", regression)
    print("CANDIDATE", evidence["candidate_decision"])


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"--seal", "--development", "--locked"}:
        raise SystemExit("use --seal, --development, or --locked")
    if sys.argv[1] == "--seal":
        seal_manifest()
    elif sys.argv[1] == "--development":
        run_development()
    else:
        run_locked()


if __name__ == "__main__":
    main()
