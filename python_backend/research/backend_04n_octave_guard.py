"""BACKEND-04N audio-derived octave-tempo guard.

The production detector is not imported and is not modified. Control beat
times are the stored BACKEND-04K predictions. A file is re-decoded only when
the pre-registered autocorrelation rule says the tracker is an octave fast.
Chord-CNN-LSTM is not called. Annotation tempo is not an inference input.

`--seal` writes the manifest before any treatment decode. `--development`
scores the 40 development recordings. `--locked` runs once, and only after
the recorded development gate passes.
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
    macro,
    mean,
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
from backend_04n_gate import (  # noqa: E402
    AUTOCORRELATION_METHOD,
    BASELINE_MACRO_HALF_BEAT,
    BASELINE_MICRO_BEAT_F,
    BASELINE_STYLE_MICRO_F,
    CONTROL,
    LOCKED_BASELINE_MICRO_BEAT_F,
    LOCKED_MICRO_F_FLOOR,
    PER_FILE_TIMEOUT_SECONDS,
    development_gate,
    dominant_autocorrelation_bpm,
    locked_regressed,
    locked_run_allowed,
    median_interval_bpm,
    dbn_interval_bounds,
    treatment_max_bpm,
    trigger_decision,
)

BASELINE_HEAD = "00cbad7d9414e941b3dab4e704ed1d9a1ccd0b52"
PARENT_MANIFEST = RESEARCH_DIR / "backend_04k_manifest.json"
PARENT_MANIFEST_SHA = RESEARCH_DIR / "backend_04k_manifest.sha256"
PARENT_EVIDENCE = RESEARCH_DIR / "backend_04k_evidence.json"
PARENT_SEAL = RESEARCH_DIR / "backend_04k_locked_test_seal.json"
MANIFEST_PATH = RESEARCH_DIR / "backend_04n_manifest.json"
MANIFEST_SHA_PATH = RESEARCH_DIR / "backend_04n_manifest.sha256"
EVIDENCE_PATH = RESEARCH_DIR / "backend_04n_evidence.json"
DECISION_PATH = RESEARCH_DIR / "backend_04n_development_decision.json"
LOCKED_SEAL_PATH = RESEARCH_DIR / "backend_04n_locked_treatment_seal.json"
AUDIO_DIR = Path("/tmp/chordmini-04k/audio")
ANNOTATION_DIR = Path("/tmp/chordmini-04k/annotation")
CHECKPOINT_DIR = Path("/tmp/chordmini-04n")
MADMOM_MODELS = Path("/tmp/chordmini-bt02-venv/lib/python3.10/site-packages/madmom/models/beats/2015")
CHORD_WEIGHTS = BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "cache_data"
ALLOWED_PATHS = {
    "python_backend/research/backend_04n_gate.py",
    "python_backend/research/backend_04n_octave_guard.py",
    "python_backend/research/backend_04n_manifest.json",
    "python_backend/research/backend_04n_manifest.sha256",
    "python_backend/research/backend_04n_evidence.json",
    "python_backend/research/backend_04n_development_decision.json",
    "python_backend/research/backend_04n_locked_treatment_seal.json",
    "python_backend/tests/test_backend_04n_gate.py",
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
OFFICIAL_COMPARE_KEYS = (
    "matched",
    "reference",
    "detected",
    "extra",
    "missed",
    "precision",
    "recall",
    "f_measure",
)


def canonical(payload: dict) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


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
    seal_digest = hashlib.sha256(PARENT_SEAL.read_bytes()).hexdigest()
    if seal_digest != evidence["locked_test"]["seal_sha256"]:
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


def assert_installed_defaults() -> None:
    from madmom.features.beats import DBNBeatTrackingProcessor

    observed = {
        "min_bpm": DBNBeatTrackingProcessor.MIN_BPM,
        "max_bpm": DBNBeatTrackingProcessor.MAX_BPM,
        "transition_lambda": DBNBeatTrackingProcessor.TRANSITION_LAMBDA,
        "observation_lambda": DBNBeatTrackingProcessor.OBSERVATION_LAMBDA,
        "correct": DBNBeatTrackingProcessor.CORRECT,
        "threshold": DBNBeatTrackingProcessor.THRESHOLD,
        "num_tempi": DBNBeatTrackingProcessor.NUM_TEMPI,
    }
    for key, value in observed.items():
        if value != CONTROL[key]:
            raise SystemExit(f"installed Madmom default drifted: {key}")
    if DBNBeatTrackingProcessor.CORRECT is not True:
        raise SystemExit("installed Madmom correction default is not enabled")


def make_treatment_tracker(max_bpm: float):
    from madmom.features.beats import DBNBeatTrackingProcessor

    tracker = DBNBeatTrackingProcessor(
        fps=100,
        correct=True,
        min_bpm=55.0,
        max_bpm=float(max_bpm),
        transition_lambda=100,
        observation_lambda=16,
        threshold=0,
        num_tempi=None,
    )
    if tracker.correct is not True or tracker.online or tracker.fps != 100:
        raise SystemExit("treatment tracker left the frozen decoder settings")
    if tracker.min_bpm != 55.0 or float(tracker.max_bpm) != float(max_bpm):
        raise SystemExit("treatment tempo bounds drifted")
    return tracker


def plan_treatment(activation, control_times) -> dict:
    """Choose the decode from audio activations and stored control beats.

    Reference tempo and labels are not arguments.
    """
    median_bpm = float(median_interval_bpm(control_times))
    autocorrelation = dominant_autocorrelation_bpm(activation)
    autocorrelation_bpm = autocorrelation.get("bpm") if autocorrelation["valid"] else None
    if autocorrelation_bpm is None:
        decision = {"triggered": False, "reason": autocorrelation["reason"], "ratio": None}
    else:
        decision = trigger_decision(median_bpm, float(autocorrelation_bpm))
    record = {
        "median_interval_bpm": median_bpm,
        "autocorrelation_bpm": None if autocorrelation_bpm is None else float(autocorrelation_bpm),
        "lag_frames": autocorrelation.get("lag_frames"),
        "triggered": bool(decision["triggered"]),
        "reason": decision["reason"],
        "ratio": decision["ratio"],
        "treatment_max_bpm": None,
        "interval_bounds": None,
        "decode": "control_copy",
        "fallback_reason": None,
    }
    if not decision["triggered"]:
        return record
    ceiling = treatment_max_bpm(float(autocorrelation_bpm))
    bounds = dbn_interval_bounds(ceiling)
    record["treatment_max_bpm"] = ceiling
    record["interval_bounds"] = None if bounds is None else [int(bounds[0]), int(bounds[1])]
    if bounds is None:
        record["decode"] = "control_fallback_invalid_interval"
        record["fallback_reason"] = "invalid_dbn_interval_range"
        return record
    record["decode"] = "treatment_dbn"
    return record


def aggregate_beats(rows: list) -> dict:
    beat_hits = beat_reference_count = beat_detected = 0
    timing = []
    for item in rows:
        official = item["official"]
        beat_hits += official["matched"]
        beat_reference_count += official["reference"]
        beat_detected += official["detected"]
        if official["mean_abs_seconds"] is not None:
            timing.append(official["mean_abs_seconds"])
    precision = beat_hits / beat_detected if beat_detected else 0.0
    recall = beat_hits / beat_reference_count if beat_reference_count else 0.0
    f_measure = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    bpm_errors = [item["bpm_error"] for item in rows if item.get("bpm_error") is not None]
    half = [item.get("half_beat_fraction") for item in rows]
    return {
        "recordings": len(rows),
        "micro_beat_precision": round(precision, 6),
        "micro_beat_recall": round(recall, 6),
        "micro_beat_f_measure": round(f_measure, 6),
        "macro_beat_f_measure": macro([item["official"]["f_measure"] for item in rows]),
        "macro_matched_beat_abs_seconds": mean(timing),
        "macro_half_beat_fraction": macro(half),
        "macro_bpm_error": macro(bpm_errors),
        "median_bpm_error": None if not bpm_errors else round(sorted(bpm_errors)[len(bpm_errors) // 2], 6),
        "min_bpm_error": None if not bpm_errors else round(min(bpm_errors), 6),
        "max_bpm_error": None if not bpm_errors else round(max(bpm_errors), 6),
        "extra_beats": sum(item["official"]["extra"] for item in rows),
        "missed_beats": sum(item["official"]["missed"] for item in rows),
        "greedy_assumption_failures": sum(1 for item in rows if not item["assumption_holds"]),
    }


def aggregate_beats_by_style(rows: list) -> dict:
    grouped = {}
    for item in rows:
        grouped.setdefault(item["style_code"], []).append(item)
    return {style: aggregate_beats(grouped[style]) for style in sorted(grouped)}


def values_match(left: dict, right: dict) -> bool:
    for key in BEAT_COMPARE_KEYS:
        if left[key] != right[key]:
            return False
    return True


def stored_control_row(item: dict) -> dict:
    phase = item["metrics"]["beats"].get("phase") or {}
    return {
        "id": item["id"],
        "style_code": item["style_code"],
        "scored_duration_seconds": item["scored_duration_seconds"],
        "official": item["metrics"]["beats"]["official"],
        "half_beat_fraction": phase.get("fraction_near_half_beat"),
        "bpm_error": item["metrics"].get("bpm_error"),
        "bpm_detected": float(item["beats"]["bpm"]),
        "assumption_holds": item["metrics"]["beats"]["assumption_holds"],
        "beat_times": [float(value) for value in item["beats"]["beats"]],
    }


def score_detected(recording_id: str, detected: list) -> dict:
    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    jams = load_jams(ANNOTATION_DIR / f"{recording_id}.jams")
    reference = beat_reference(jams)
    scored = min(float(jams["file_metadata"]["duration"]), audio_probe(audio)["duration_seconds"])
    reference_beats = [instant for instant in reference["beats"] if instant <= scored + 1e-6]
    tempo = reference["tempo_events"][0]["bpm"] if len(reference["tempo_events"]) == 1 else None
    beats = score_beats(reference_beats, detected, tempo)
    bpm = float(median_interval_bpm(detected))
    return {
        "id": recording_id,
        "style_code": parse_recording_id(recording_id)["style_code"],
        "scored_duration_seconds": round(scored, 6),
        "official": beats["official"],
        "half_beat_fraction": (beats.get("phase") or {}).get("fraction_near_half_beat"),
        "bpm_error": None if tempo is None else round(abs(bpm - tempo), 6),
        "bpm_detected": bpm,
        "assumption_holds": beats["assumption_holds"],
        "beat_times": [float(value) for value in detected],
    }


def official_matches(stored: dict, scored: dict) -> bool:
    if stored["half_beat_fraction"] != scored["half_beat_fraction"]:
        return False
    if stored["assumption_holds"] != scored["assumption_holds"]:
        return False
    if stored.get("bpm_error") != scored.get("bpm_error"):
        return False
    for key in OFFICIAL_COMPARE_KEYS:
        if stored["official"][key] != scored["official"][key]:
            return False
    return True


def assert_control_integrity(evidence: dict, parent_manifest: dict) -> list:
    rows = []
    for item in evidence["development"]["recordings"]:
        if item["id"] not in DEVELOPMENT_IDS:
            raise SystemExit("development evidence contains a recording outside the split")
        row = stored_control_row(item)
        recomputed = float(median_interval_bpm(row["beat_times"]))
        if abs(recomputed - row["bpm_detected"]) > 1e-4:
            raise SystemExit(f"stored BPM does not match the median interval for {row['id']}")
        assert_audio_hash(parent_manifest, row["id"])
        rescored = score_detected(row["id"], row["beat_times"])
        if not official_matches(row, rescored):
            raise SystemExit(f"stored control score does not rescore for {row['id']}")
        rows.append(row)
    if [row["id"] for row in rows] != list(DEVELOPMENT_IDS):
        raise SystemExit("stored development order drifted")
    reproduced = aggregate_beats(rows)
    if not values_match(reproduced, evidence["development"]["aggregate"]):
        raise SystemExit("stored development beats do not reaggregate to the sealed baseline")
    if reproduced["micro_beat_f_measure"] != round(BASELINE_MICRO_BEAT_F, 6) and reproduced["micro_beat_f_measure"] != BASELINE_MICRO_BEAT_F:
        if round(reproduced["micro_beat_f_measure"], 6) != round(BASELINE_MICRO_BEAT_F, 6):
            raise SystemExit("development baseline F drifted")
    if reproduced["extra_beats"] != 567 or reproduced["missed_beats"] != 448:
        raise SystemExit("development extra or missed counts drifted")
    if reproduced["macro_half_beat_fraction"] != BASELINE_MACRO_HALF_BEAT:
        raise SystemExit("development half-beat baseline drifted")
    return rows


def gate_record() -> dict:
    return {
        "triggered_precision_gain": 0.20,
        "untriggered_micro_f_decrease_limit": 0.005,
        "macro_half_beat_maximum": BASELINE_MACRO_HALF_BEAT,
        "style_micro_f_drop_limit": 0.05,
        "style_baseline_micro_f": BASELINE_STYLE_MICRO_F,
        "baseline_micro_beat_f": BASELINE_MICRO_BEAT_F,
        "warm_rtf_maximum": 0.20,
        "peak_rss_mb_maximum": 1200,
        "locked_baseline_micro_beat_f": LOCKED_BASELINE_MICRO_BEAT_F,
        "locked_micro_f_floor": LOCKED_MICRO_F_FLOOR,
        "locked_rule": "Run the treatment once only after the development gate passes. Reject if locked micro beat F is below 0.680362.",
        "keep_rule": "KEEP only when every development condition passes and the locked micro beat F is at least 0.680362. KEEP does not authorize a production change.",
        "no_trigger_rule": "If no file triggers, the candidate is REJECT and the locked test stays closed.",
    }


def seal_manifest() -> None:
    assert_worktree_scope()
    parent_manifest, evidence = load_parent()
    assert_model_hashes(parent_manifest)
    runtime = runtime_versions()
    if runtime != parent_manifest["runtime"]:
        raise SystemExit("runtime drifted from the BACKEND-04K manifest: " + json.dumps(runtime))
    development = evidence["development"]
    if round(development["aggregate"]["micro_beat_f_measure"], 6) != round(BASELINE_MICRO_BEAT_F, 6):
        raise SystemExit("development baseline F drifted")
    if development["aggregate"]["macro_half_beat_fraction"] != BASELINE_MACRO_HALF_BEAT:
        raise SystemExit("development half-beat baseline drifted")
    if development["aggregate"]["extra_beats"] != 567 or development["aggregate"]["missed_beats"] != 448:
        raise SystemExit("development extra or missed counts drifted")
    for style, expected in BASELINE_STYLE_MICRO_F.items():
        if round(development["by_style"][style]["micro_beat_f_measure"], 6) != round(expected, 6):
            raise SystemExit(f"style baseline drifted: {style}")
    locked = evidence["locked_test"]["aggregate"]
    if locked["micro_beat_f_measure"] != LOCKED_BASELINE_MICRO_BEAT_F:
        raise SystemExit("locked aggregate pin drifted")
    if list(DEVELOPMENT_IDS) != list(parent_manifest["split"]["development_ids"]):
        raise SystemExit("development split drifted")
    manifest = {
        "phase": "BACKEND-04N",
        "parent_head": BASELINE_HEAD,
        "parent_manifest_sha256": PARENT_MANIFEST_SHA.read_text(encoding="utf-8").strip(),
        "parent_evidence_sha256": hashlib.sha256(PARENT_EVIDENCE.read_bytes()).hexdigest(),
        "parent_locked_seal_sha256": hashlib.sha256(PARENT_SEAL.read_bytes()).hexdigest(),
        "dataset": parent_manifest["dataset"],
        "split": parent_manifest["split"],
        "control": CONTROL,
        "autocorrelation_method": AUTOCORRELATION_METHOD,
        "trigger": {
            "formula": "ratio = median_interval_BPM / dominant_autocorrelation_BPM",
            "ratio_minimum_inclusive": 1.90,
            "ratio_maximum_inclusive": 2.10,
            "autocorrelation_bpm_minimum": 55.0,
            "autocorrelation_bpm_maximum": 215.0,
            "both_bpm_must_be_finite_and_positive": True,
            "annotation_tempo_at_inference": False,
        },
        "treatment_decode": {
            "tracker": "DBNBeatTrackingProcessor",
            "fps": 100,
            "correct": True,
            "min_bpm": 55.0,
            "max_bpm": "min(215, 1.25 * autocorrelation_BPM)",
            "transition_lambda": 100,
            "observation_lambda": 16,
            "threshold": 0,
            "num_tempi": None,
            "invalid_interval_policy": "return the stored control beats and record invalid_dbn_interval_range",
            "nontriggered_policy": "return the stored control beats unchanged",
            "phase_inversion": "out of scope",
        },
        "unchanged": [
            "RNNBeatProcessor",
            "Madmom BLSTM weights",
            "Chord-CNN-LSTM weights and decoder",
            "audio preprocessing",
            "70 ms beat matcher and BACKEND-04K aggregation",
            "production DBNBeatTrackingProcessor(fps=100) with correction enabled",
            "Flask routes, Next.js, Electron, Windows installer, i18n, quotas, and authentication",
        ],
        "gate": gate_record(),
        "development_order": list(DEVELOPMENT_IDS),
        "model_files": parent_manifest["model_files"],
        "runtime": runtime,
        "performance_budget": {
            "warm_rtf_maximum": 0.20,
            "peak_rss_mb_maximum": 1200,
            "per_file_timeout_seconds": PER_FILE_TIMEOUT_SECONDS,
            "warm_definition": "RNN activation, autocorrelation, and the optional treatment DBN over every development file after the first, divided by scored duration. Model construction is excluded.",
        },
        "diagnostic_ids_excluded": list(DIAGNOSTIC_IDS),
        "reserve_closed": True,
        "production_integration": False,
    }
    if manifest["development_order"] != list(DEVELOPMENT_IDS) or len(set(manifest["development_order"])) != 40:
        raise SystemExit("development order is not the sealed 40-file split")
    payload = canonical(manifest)
    MANIFEST_PATH.write_bytes(payload)
    MANIFEST_SHA_PATH.write_text(hashlib.sha256(payload).hexdigest() + "\n", encoding="utf-8")
    assert_worktree_scope()
    print(MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip())


def load_manifest() -> dict:
    payload = MANIFEST_PATH.read_bytes()
    if hashlib.sha256(payload).hexdigest() != MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip():
        raise SystemExit("BACKEND-04N manifest hash mismatch")
    manifest = json.loads(payload.decode("utf-8"))
    if manifest["control"] != CONTROL:
        raise SystemExit("control configuration drifted from the sealed manifest")
    if manifest["autocorrelation_method"] != AUTOCORRELATION_METHOD:
        raise SystemExit("autocorrelation method drifted")
    if manifest["trigger"]["ratio_minimum_inclusive"] != 1.90 or manifest["trigger"]["ratio_maximum_inclusive"] != 2.10:
        raise SystemExit("trigger bounds drifted")
    if manifest["gate"]["triggered_precision_gain"] != 0.20:
        raise SystemExit("precision gate drifted")
    if manifest["gate"]["locked_micro_f_floor"] != LOCKED_MICRO_F_FLOOR:
        raise SystemExit("locked floor drifted")
    if manifest["development_order"] != list(DEVELOPMENT_IDS):
        raise SystemExit("development order drifted")
    if manifest["treatment_decode"]["correct"] is not True:
        raise SystemExit("treatment correction flag drifted")
    return manifest


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
    checkpoint_path(name).write_bytes(canonical({"runner_sha256": runner_hash, "rows": rows}))


def decode_file(rnn, recording_id: str, control_times: list) -> dict:
    import numpy as np

    audio = AUDIO_DIR / f"{recording_id}_mic.wav"
    started = time.perf_counter()
    activation = np.asarray(rnn(str(audio)), dtype=float)
    rnn_seconds = time.perf_counter() - started
    started = time.perf_counter()
    plan = plan_treatment(activation, control_times)
    autocorrelation_seconds = time.perf_counter() - started
    dbn_seconds = 0.0
    if plan["decode"] == "treatment_dbn":
        tracker = make_treatment_tracker(plan["treatment_max_bpm"])
        started = time.perf_counter()
        detected = tracker(np.array(activation, copy=True))
        dbn_seconds = time.perf_counter() - started
        if tracker.correct is not True:
            raise SystemExit(f"treatment correction was disabled for {recording_id}")
        treatment_times = [float(value) for value in detected]
    else:
        treatment_times = [float(value) for value in control_times]
    path_seconds = rnn_seconds + autocorrelation_seconds + dbn_seconds
    return {
        "plan": plan,
        "treatment_times": treatment_times,
        "rnn_seconds": round(rnn_seconds, 4),
        "autocorrelation_seconds": round(autocorrelation_seconds, 4),
        "dbn_seconds": round(dbn_seconds, 4),
        "path_seconds": round(path_seconds, 4),
    }


def same_times(left: list, right: list) -> bool:
    if len(left) != len(right):
        return False
    return all(float(a) == float(b) for a, b in zip(left, right))


def row_from_times(control: dict, treatment_times: list, copied: bool) -> dict:
    if copied:
        treated = {
            "id": control["id"],
            "style_code": control["style_code"],
            "official": control["official"],
            "half_beat_fraction": control["half_beat_fraction"],
            "bpm_error": control["bpm_error"],
            "bpm_detected": control["bpm_detected"],
            "assumption_holds": control["assumption_holds"],
            "beat_times": list(control["beat_times"]),
        }
        if not same_times(treated["beat_times"], treatment_times):
            raise SystemExit(f"control copy drifted for {control['id']}")
        return treated
    return score_detected(control["id"], treatment_times)


def run_development() -> None:
    assert_worktree_scope()
    manifest = load_manifest()
    parent_manifest, evidence = load_parent()
    assert_model_hashes(parent_manifest)
    assert_installed_defaults()
    if runtime_versions() != manifest["runtime"]:
        raise SystemExit("runtime drifted after the seal")
    if EVIDENCE_PATH.is_file():
        raise SystemExit("development evidence already exists")
    control_rows = assert_control_integrity(evidence, parent_manifest)
    by_id = {row["id"]: row for row in control_rows}
    from madmom.features.beats import RNNBeatProcessor

    started = time.perf_counter()
    rnn = RNNBeatProcessor()
    init_seconds = round(time.perf_counter() - started, 4)
    runner_hash = file_digest(Path(__file__))
    completed = load_checkpoint("development.json", runner_hash)
    rows = []
    for index, recording_id in enumerate(manifest["development_order"]):
        control = by_id[recording_id]
        if recording_id in completed:
            decoded = completed[recording_id]
        else:
            decoded = decode_file(rnn, recording_id, control["beat_times"])
            if decoded["path_seconds"] > PER_FILE_TIMEOUT_SECONDS:
                raise SystemExit(f"timeout on {recording_id}")
            completed[recording_id] = decoded
            save_checkpoint("development.json", runner_hash, completed)
        copied = decoded["plan"]["decode"] != "treatment_dbn"
        if not decoded["plan"]["triggered"] and not same_times(decoded["treatment_times"], control["beat_times"]):
            raise SystemExit(f"non-triggered output changed for {recording_id}")
        treatment = row_from_times(control, decoded["treatment_times"], copied)
        rows.append({
            "id": recording_id,
            "style_code": control["style_code"],
            "scored_duration_seconds": control["scored_duration_seconds"],
            "cold": index == 0,
            "trigger": decoded["plan"],
            "control_beat_count": len(control["beat_times"]),
            "treatment_beat_count": len(treatment["beat_times"]),
            "control_bpm": control["bpm_detected"],
            "treatment_bpm": treatment["bpm_detected"],
            "timings": {
                "rnn_seconds": decoded["rnn_seconds"],
                "autocorrelation_seconds": decoded["autocorrelation_seconds"],
                "dbn_seconds": decoded["dbn_seconds"],
                "path_seconds": decoded["path_seconds"],
            },
            "control_beat_times": control["beat_times"],
            "treatment_beat_times": treatment["beat_times"],
            "control": {key: value for key, value in control.items() if key != "beat_times"},
            "treatment": {key: value for key, value in treatment.items() if key != "beat_times"},
            "peak_rss_mb": round(peak_mb(), 2),
        })
        print(
            f"development {index + 1}/40 {recording_id} triggered={decoded['plan']['triggered']} {decoded['path_seconds']:.3f}s",
            flush=True,
        )
    control_scored = [row["control"] for row in rows]
    treatment_scored = [row["treatment"] for row in rows]
    triggered_ids = [row["id"] for row in rows if row["trigger"]["triggered"]]
    reproduced = aggregate_beats(control_scored)
    treated = aggregate_beats(treatment_scored)
    if not values_match(reproduced, evidence["development"]["aggregate"]):
        raise SystemExit("control aggregate changed while scoring the treatment")
    warm = [row for row in rows if not row["cold"]]
    warm_audio = sum(row["scored_duration_seconds"] for row in warm)
    warm_path = sum(row["timings"]["path_seconds"] for row in warm)
    warm_rtf = round(warm_path / warm_audio, 4) if warm_audio else None
    overall_peak = round(peak_mb(), 2)
    gate = development_gate(control_scored, treatment_scored, triggered_ids, True, warm_rtf, overall_peak)
    decision = {
        "control_integrity": True,
        "acceptance_gate_passed": bool(gate["passed"]),
        "candidate_decision": "REJECT" if not gate["passed"] else "PENDING_LOCKED_TEST",
        "gate": gate,
        "triggered_ids": triggered_ids,
    }
    payload = {
        "phase": "BACKEND-04N",
        "manifest_sha256": MANIFEST_SHA_PATH.read_text(encoding="utf-8").strip(),
        "chord_inference_invoked": False,
        "chord_weights_unchanged": True,
        "diagnostic_scored": False,
        "reserve_accessed": False,
        "development": {
            "complete": True,
            "count": 40,
            "triggered_count": len(triggered_ids),
            "triggered_ids": triggered_ids,
            "control": reproduced,
            "control_by_style": aggregate_beats_by_style(control_scored),
            "treatment": treated,
            "treatment_by_style": aggregate_beats_by_style(treatment_scored),
            "gate": gate,
            "recordings": rows,
        },
        "decision": decision,
        "performance": {
            "cpu": cpu_info(),
            "cold_init_seconds": init_seconds,
            "cold_recording_id": rows[0]["id"],
            "cold_path_seconds": rows[0]["timings"]["path_seconds"],
            "warm_path_seconds": round(warm_path, 4),
            "warm_audio_seconds": round(warm_audio, 6),
            "warm_real_time_factor": warm_rtf,
            "peak_rss_mb": overall_peak,
            "failures": 0,
            "timeouts": 0,
        },
        "locked_test_executed": False,
        "candidate_decision": decision["candidate_decision"],
    }
    EVIDENCE_PATH.write_bytes(canonical(payload))
    decision_record = {
        "control_integrity": True,
        "acceptance_gate_passed": decision["acceptance_gate_passed"],
        "candidate_decision": decision["candidate_decision"],
        "triggered_ids": triggered_ids,
        "evidence_sha256": hashlib.sha256(EVIDENCE_PATH.read_bytes()).hexdigest(),
        "locked_run_allowed": locked_run_allowed(decision),
    }
    DECISION_PATH.write_bytes(canonical(decision_record))
    print("CONTROL_INTEGRITY", True)
    print("GATE_PASSED", decision["acceptance_gate_passed"])
    print("TRIGGERED", len(triggered_ids))
    print("TRIGGERED_IDS", ",".join(triggered_ids))
    print("CONTROL_MICRO_F", reproduced["micro_beat_f_measure"])
    print("TREATMENT_MICRO_F", treated["micro_beat_f_measure"])
    print("TREATMENT_HALF", treated["macro_half_beat_fraction"])
    print("LOCKED_ALLOWED", decision_record["locked_run_allowed"])
    print("WARM_RTF", warm_rtf)
    print("PEAK_RSS_MB", overall_peak)


def locked_control_rows(parent_manifest: dict) -> list:
    seal = json.loads(PARENT_SEAL.read_text(encoding="utf-8"))
    rows = []
    for item in seal["recordings"]:
        row = stored_control_row(item)
        if row["id"] not in LOCKED_TEST_IDS:
            raise SystemExit("locked seal contains a recording outside the locked split")
        assert_audio_hash(parent_manifest, row["id"])
        rows.append(row)
    if [row["id"] for row in rows] != list(LOCKED_TEST_IDS):
        raise SystemExit("locked seal order drifted")
    return rows


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
    assert_installed_defaults()
    if runtime_versions() != manifest["runtime"]:
        raise SystemExit("runtime drifted after the seal")
    locked_baseline_f = parent_evidence["locked_test"]["aggregate"]["micro_beat_f_measure"]
    if locked_baseline_f != LOCKED_BASELINE_MICRO_BEAT_F:
        raise SystemExit("locked baseline pin drifted")
    del parent_evidence
    controls = locked_control_rows(parent_manifest)
    from madmom.features.beats import RNNBeatProcessor

    started = time.perf_counter()
    rnn = RNNBeatProcessor()
    init_seconds = round(time.perf_counter() - started, 4)
    runner_hash = file_digest(Path(__file__))
    completed = load_checkpoint("locked.json", runner_hash)
    rows = []
    for index, control in enumerate(controls):
        recording_id = control["id"]
        if recording_id not in completed:
            decoded = decode_file(rnn, recording_id, control["beat_times"])
            if decoded["path_seconds"] > PER_FILE_TIMEOUT_SECONDS:
                raise SystemExit("timeout on a locked recording")
            completed[recording_id] = decoded
            save_checkpoint("locked.json", runner_hash, completed)
        decoded = completed[recording_id]
        copied = decoded["plan"]["decode"] != "treatment_dbn"
        if not decoded["plan"]["triggered"] and not same_times(decoded["treatment_times"], control["beat_times"]):
            raise SystemExit("non-triggered locked output changed")
        treatment = row_from_times(control, decoded["treatment_times"], copied)
        rows.append({
            "id": recording_id,
            "style_code": control["style_code"],
            "scored_duration_seconds": control["scored_duration_seconds"],
            "triggered": bool(decoded["plan"]["triggered"]),
            "decode": decoded["plan"]["decode"],
            "timings": {
                "rnn_seconds": decoded["rnn_seconds"],
                "autocorrelation_seconds": decoded["autocorrelation_seconds"],
                "dbn_seconds": decoded["dbn_seconds"],
                "path_seconds": decoded["path_seconds"],
            },
            "treatment_beat_times": treatment["beat_times"],
            "treatment": {key: value for key, value in treatment.items() if key != "beat_times"},
            "peak_rss_mb": round(peak_mb(), 2),
        })
        print(f"locked {index + 1}/20", flush=True)
    treated = aggregate_beats([row["treatment"] for row in rows])
    by_style = aggregate_beats_by_style([row["treatment"] for row in rows])
    regression = locked_regressed(treated["micro_beat_f_measure"])
    triggered_ids = [row["id"] for row in rows if row["triggered"]]
    seal = {
        "role": "Per-file locked treatment outputs. Do not use these rows to choose a parameter or revise the gate.",
        "runs": 1,
        "triggered_count": len(triggered_ids),
        "triggered_ids": triggered_ids,
        "aggregate": treated,
        "by_style": by_style,
        "recordings": rows,
    }
    LOCKED_SEAL_PATH.write_bytes(canonical(seal))
    warm = rows[1:]
    warm_audio = sum(row["scored_duration_seconds"] for row in warm)
    warm_path = sum(row["timings"]["path_seconds"] for row in warm)
    evidence["locked_test_executed"] = True
    evidence["locked_test"] = {
        "runs": 1,
        "used_for_parameter_selection": False,
        "seal_file": LOCKED_SEAL_PATH.name,
        "seal_sha256": hashlib.sha256(LOCKED_SEAL_PATH.read_bytes()).hexdigest(),
        "baseline_micro_beat_f": LOCKED_BASELINE_MICRO_BEAT_F,
        "treatment_micro_beat_f": treated["micro_beat_f_measure"],
        "micro_beat_f_delta": round(treated["micro_beat_f_measure"] - LOCKED_BASELINE_MICRO_BEAT_F, 6),
        "treatment": treated,
        "treatment_by_style": by_style,
        "triggered_count": len(triggered_ids),
        "regressed": regression,
        "performance": {
            "cold_init_seconds": init_seconds,
            "cold_path_seconds": rows[0]["timings"]["path_seconds"],
            "warm_path_seconds": round(warm_path, 4),
            "warm_audio_seconds": round(warm_audio, 6),
            "warm_real_time_factor": round(warm_path / warm_audio, 4) if warm_audio else None,
            "peak_rss_mb": round(peak_mb(), 2),
            "failures": 0,
            "timeouts": 0,
        },
    }
    evidence["candidate_decision"] = "REJECT" if regression else "KEEP"
    EVIDENCE_PATH.write_bytes(canonical(evidence))
    print("LOCKED_MICRO_F", treated["micro_beat_f_measure"])
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
