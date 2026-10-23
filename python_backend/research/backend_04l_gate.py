"""Acceptance rule for the Madmom correct=False ablation.

The numbers below are the BACKEND-04K development aggregates. They were copied
here before the treatment run. Do not edit them after treatment beats exist.
"""

BASELINE_MICRO_BEAT_F = 0.779300
TREATMENT_MICRO_BEAT_F_MINIMUM = 0.809300
BASELINE_MACRO_HALF_BEAT = 0.128906
TREATMENT_MACRO_HALF_BEAT_MAXIMUM = 0.128906
STYLE_MICRO_F_DROP_LIMIT = 0.05
CHORD_REPRODUCTION_TOLERANCE = 1e-4
LOCKED_BEAT_F_REGRESSION_TOLERANCE = 1e-4
CONTROL_REPRODUCTION_TOLERANCE_SECONDS = 1e-6
WARM_RTF_MAXIMUM = 0.20
PEAK_RSS_MB_MAXIMUM = 1200.0
PER_FILE_TIMEOUT_SECONDS = 300
REPRESENTATIVE_RECORDING_ID = "01_SS3-84-Bb_comp"
BASELINE_DURATION_WEIGHTED_ROOT = 0.933983
BASELINE_DURATION_WEIGHTED_BARE_TRIAD = 0.913753
BASELINE_STYLE_MICRO_F = {
    "BN": 0.853007,
    "Funk": 0.827723,
    "Jazz": 0.928910,
    "Rock": 0.780868,
    "SS": 0.523207,
}
LOCKED_BASELINE_MICRO_BEAT_F = 0.680462
LOCKED_BASELINE_MACRO_BEAT_F = 0.672273
LOCKED_BASELINE_MACRO_HALF_BEAT = 0.152344

CONTROL = {
    "class": "DBNBeatTrackingProcessor",
    "fps": 100,
    "correct": True,
    "min_bpm": 55.0,
    "max_bpm": 215.0,
    "transition_lambda": 100,
    "observation_lambda": 16,
    "threshold": 0,
    "num_tempi": None,
}
TREATMENT = {**CONTROL, "correct": False}


def aggregate_beats(rows: list) -> dict:
    from backend_04i_guitarset_eval import macro, mean

    beat_hits = beat_reference = beat_detected = 0
    timing = []
    for item in rows:
        official = item["official"]
        beat_hits += official["matched"]
        beat_reference += official["reference"]
        beat_detected += official["detected"]
        if official["mean_abs_seconds"] is not None:
            timing.append(official["mean_abs_seconds"])
    precision = beat_hits / beat_detected if beat_detected else 0.0
    recall = beat_hits / beat_reference if beat_reference else 0.0
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


def style_drops(treatment_by_style: dict, baseline: dict = None) -> dict:
    baseline = BASELINE_STYLE_MICRO_F if baseline is None else baseline
    drops = {}
    for style, expected in baseline.items():
        observed = treatment_by_style.get(style, {}).get("micro_beat_f_measure")
        drops[style] = None if observed is None else round(expected - observed, 6)
    return drops


def acceptance_gate(treatment_micro_f: float, treatment_half: float, treatment_by_style: dict, chord_root_delta: float, chord_triad_delta: float) -> dict:
    drops = style_drops(treatment_by_style)
    collapses = {style: drop for style, drop in drops.items() if drop is None or drop > STYLE_MICRO_F_DROP_LIMIT}
    requirement_a = treatment_micro_f is not None and treatment_micro_f >= TREATMENT_MICRO_BEAT_F_MINIMUM
    requirement_b = treatment_half is not None and treatment_half < TREATMENT_MACRO_HALF_BEAT_MAXIMUM
    chord_ok = abs(chord_root_delta) <= CHORD_REPRODUCTION_TOLERANCE and abs(chord_triad_delta) <= CHORD_REPRODUCTION_TOLERANCE
    reasons = []
    if not requirement_a:
        reasons.append("micro beat F is below 0.809300")
    if not requirement_b:
        reasons.append("macro half-beat fraction is not below 0.128906")
    if collapses:
        reasons.append("per-style micro beat F dropped by more than 0.05")
    if not chord_ok:
        reasons.append("chord root or bare-triad recall moved by more than 1e-4")
    return {
        "passed": not reasons,
        "requirement_a": requirement_a,
        "requirement_b": requirement_b,
        "style_drops": drops,
        "style_collapses": collapses,
        "chord_ok": chord_ok,
        "reasons": reasons,
    }


def budget_passed(warm_rtf: float, peak_rss_mb: float) -> bool:
    return warm_rtf <= WARM_RTF_MAXIMUM and peak_rss_mb <= PEAK_RSS_MB_MAXIMUM


def locked_regressed(treatment_micro_f: float, baseline_micro_f: float = LOCKED_BASELINE_MICRO_BEAT_F) -> bool:
    return treatment_micro_f < baseline_micro_f - LOCKED_BEAT_F_REGRESSION_TOLERANCE


def locked_run_allowed(decision: dict) -> bool:
    return bool(decision.get("control_integrity")) and bool(decision.get("acceptance_gate_passed"))


def candidate_decision(decision: dict, locked_micro_f=None) -> str:
    if not decision.get("control_integrity") or not decision.get("acceptance_gate_passed"):
        return "REJECT"
    if not decision.get("budget_passed"):
        return "REJECT"
    if locked_micro_f is None:
        return "REJECT"
    if locked_regressed(locked_micro_f):
        return "REJECT"
    return "KEEP"
