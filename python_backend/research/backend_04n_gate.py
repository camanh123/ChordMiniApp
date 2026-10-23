"""Pre-registered octave-tempo guard for Madmom.

The autocorrelation and the trigger bounds were fixed from the BACKEND-04M
diagnosis before this treatment decode. Do not edit them after treatment
beats exist. Ground-truth tempo is not an input.
"""

import math

import numpy as np

FPS = 100
MIN_BPM = 55.0
MAX_BPM = 215.0
RATIO_MINIMUM = 1.90
RATIO_MAXIMUM = 2.10
AUTOCORRELATION_MARGIN = 1.25
BASELINE_MACRO_HALF_BEAT = 0.128906
BASELINE_MICRO_BEAT_F = 0.779300
TRIGGERED_PRECISION_GAIN = 0.20
UNTRIGGERED_MICRO_F_DECREASE_LIMIT = 0.005
STYLE_MICRO_F_DROP_LIMIT = 0.05
WARM_RTF_MAXIMUM = 0.20
PEAK_RSS_MB_MAXIMUM = 1200.0
PER_FILE_TIMEOUT_SECONDS = 300
LOCKED_BASELINE_MICRO_BEAT_F = 0.680462
LOCKED_MICRO_F_FLOOR = 0.680362
BASELINE_STYLE_MICRO_F = {
    "BN": 0.853007,
    "Funk": 0.827723,
    "Jazz": 0.928910,
    "Rock": 0.780868,
    "SS": 0.523207,
}

CONTROL = {
    "processor": "RNNBeatProcessor()",
    "tracker": "DBNBeatTrackingProcessor",
    "fps": FPS,
    "correct": True,
    "min_bpm": MIN_BPM,
    "max_bpm": MAX_BPM,
    "transition_lambda": 100,
    "observation_lambda": 16,
    "threshold": 0,
    "num_tempi": None,
}
AUTOCORRELATION_METHOD = (
    "Mean-center the 100 fps RNN activation. Take the nonnegative lags of a "
    "full autocorrelation and divide by lag 0. The dominant lag is the maximum "
    "inside the inclusive frame window round(6000/215) through round(6000/55). "
    "Autocorrelation BPM is 6000 divided by that lag. No annotation tempo is read."
)


def lag_window() -> tuple:
    return int(round(FPS * 60.0 / MAX_BPM)), int(round(FPS * 60.0 / MIN_BPM))


def dominant_autocorrelation_bpm(activation) -> dict:
    series = np.asarray(activation, dtype=float)
    if series.ndim != 1 or series.size < 3 or not np.isfinite(series).all():
        return {"valid": False, "reason": "activation is not a finite vector", "bpm": None, "lag_frames": None}
    centered = series - float(np.mean(series))
    correlation = np.correlate(centered, centered, mode="full")
    correlation = correlation[series.size - 1 :]
    if correlation[0] <= 0 or not np.isfinite(correlation[0]):
        return {"valid": False, "reason": "autocorrelation energy is not positive", "bpm": None, "lag_frames": None}
    correlation = correlation / correlation[0]
    minimum, maximum = lag_window()
    maximum = min(maximum, correlation.size - 1)
    if maximum <= minimum:
        return {"valid": False, "reason": "autocorrelation lag window is empty", "bpm": None, "lag_frames": None}
    lag = int(np.argmax(correlation[minimum : maximum + 1]) + minimum)
    bpm = float(FPS * 60.0 / lag)
    return {"valid": True, "reason": "dominant lag", "bpm": bpm, "lag_frames": lag}


def median_interval_bpm(beat_times) -> float:
    times = np.asarray(list(beat_times), dtype=float)
    if times.size < 2:
        return 120.0
    interval = float(np.median(np.diff(times)))
    if not np.isfinite(interval) or interval <= 0:
        return 120.0
    return 60.0 / interval


def trigger_decision(median_bpm: float, autocorrelation_bpm: float) -> dict:
    values = (median_bpm, autocorrelation_bpm)
    if any(not math.isfinite(value) or value <= 0 for value in values):
        return {"triggered": False, "reason": "bpm is not finite and positive", "ratio": None}
    if autocorrelation_bpm < MIN_BPM or autocorrelation_bpm > MAX_BPM:
        return {"triggered": False, "reason": "autocorrelation bpm is outside 55-215", "ratio": None}
    ratio = float(median_bpm) / float(autocorrelation_bpm)
    if RATIO_MINIMUM <= ratio <= RATIO_MAXIMUM:
        return {"triggered": True, "reason": "octave_overestimate", "ratio": ratio}
    return {"triggered": False, "reason": "ratio is outside 1.90-2.10", "ratio": ratio}


def treatment_max_bpm(autocorrelation_bpm: float) -> float:
    return float(min(MAX_BPM, AUTOCORRELATION_MARGIN * float(autocorrelation_bpm)))


def dbn_interval_bounds(max_bpm: float, min_bpm: float = MIN_BPM, fps: int = FPS):
    """Mirror DBNBeatTrackingProcessor's integer interval construction."""
    if not math.isfinite(max_bpm) or not math.isfinite(min_bpm) or max_bpm <= min_bpm:
        return None
    min_interval = 60.0 * fps / max_bpm
    max_interval = 60.0 * fps / min_bpm
    start = int(np.round(min_interval))
    stop = int(np.round(max_interval))
    if start < 1 or start > stop:
        return None
    return start, stop


def micro_f(rows: list) -> float:
    hits = sum(row["official"]["matched"] for row in rows)
    reference = sum(row["official"]["reference"] for row in rows)
    detected = sum(row["official"]["detected"] for row in rows)
    precision = hits / detected if detected else 0.0
    recall = hits / reference if reference else 0.0
    if precision + recall == 0:
        return 0.0
    return round(2 * precision * recall / (precision + recall), 6)


def mean_precision(rows: list):
    if not rows:
        return None
    return round(sum(row["official"]["precision"] for row in rows) / len(rows), 6)


def style_micro_f(rows: list) -> dict:
    grouped = {}
    for row in rows:
        grouped.setdefault(row["style_code"], []).append(row)
    return {style: micro_f(grouped[style]) for style in sorted(grouped)}


def development_gate(control_rows: list, treatment_rows: list, triggered_ids: list, chord_ok: bool, warm_rtf: float, peak_rss_mb: float) -> dict:
    from backend_04i_guitarset_eval import macro

    triggered = set(triggered_ids)
    control_triggered = [row for row in control_rows if row["id"] in triggered]
    treatment_triggered = [row for row in treatment_rows if row["id"] in triggered]
    control_rest = [row for row in control_rows if row["id"] not in triggered]
    treatment_rest = [row for row in treatment_rows if row["id"] not in triggered]
    control_precision = mean_precision(control_triggered)
    treatment_precision = mean_precision(treatment_triggered)
    precision_delta = None if control_precision is None else round(treatment_precision - control_precision, 6)
    untriggered_delta = 0.0 if not control_rest else round(micro_f(treatment_rest) - micro_f(control_rest), 6)
    half = macro([row.get("half_beat_fraction") for row in treatment_rows])
    control_styles = style_micro_f(control_rows)
    treatment_styles = style_micro_f(treatment_rows)
    style_drops = {
        style: round(control_styles[style] - treatment_styles.get(style, 0.0), 6)
        for style in control_styles
    }
    collapses = {style: drop for style, drop in style_drops.items() if drop > STYLE_MICRO_F_DROP_LIMIT}
    reasons = []
    if not triggered:
        reasons.append("no file triggered")
    elif precision_delta is None or precision_delta < TRIGGERED_PRECISION_GAIN:
        reasons.append("triggered precision gain is below 0.20")
    if untriggered_delta < -UNTRIGGERED_MICRO_F_DECREASE_LIMIT:
        reasons.append("untriggered micro F decreased by more than 0.005")
    if half is None or half > BASELINE_MACRO_HALF_BEAT:
        reasons.append("macro half-beat fraction is above 0.128906")
    if collapses:
        reasons.append("a style micro F decreased by more than 0.05")
    if not chord_ok:
        reasons.append("chord results, weights, or APIs changed")
    if warm_rtf is None or warm_rtf > WARM_RTF_MAXIMUM:
        reasons.append("warm real-time factor is above 0.20")
    if peak_rss_mb is None or peak_rss_mb > PEAK_RSS_MB_MAXIMUM:
        reasons.append("peak RSS is above 1.2 GB")
    return {
        "passed": not reasons,
        "reasons": reasons,
        "triggered_count": len(triggered),
        "control_triggered_precision": control_precision,
        "treatment_triggered_precision": treatment_precision,
        "triggered_precision_delta": precision_delta,
        "untriggered_micro_f_delta": untriggered_delta,
        "macro_half_beat_fraction": half,
        "style_drops": style_drops,
        "style_collapses": collapses,
        "development_control_micro_f": micro_f(control_rows),
        "development_treatment_micro_f": micro_f(treatment_rows),
        "chord_ok": chord_ok,
        "warm_rtf": warm_rtf,
        "peak_rss_mb": peak_rss_mb,
    }


def locked_regressed(treatment_micro_f: float) -> bool:
    return treatment_micro_f < LOCKED_MICRO_F_FLOOR


def locked_run_allowed(decision: dict) -> bool:
    return bool(decision.get("acceptance_gate_passed"))
