"""Pinned split and score definitions for the BACKEND-04K baseline.

These rules were fixed before the development and locked-test recordings were
scored. The functions reuse the BACKEND-04I matchers so the five diagnostic
excerpts stay comparable. Nothing here changes a model weight or a detector
setting.
"""

from backend_04i_guitarset_eval import (
    BEAT_WINDOW_SECONDS,
    PITCH_CLASS,
    beat_phase,
    boundary_errors,
    label_at,
    macro,
    match_events,
    mean,
    parse_harte,
    time_slices,
)

DIAGNOSTIC_IDS = (
    "00_BN2-131-B_comp",
    "00_Funk2-108-Eb_comp",
    "00_Jazz2-110-Bb_comp",
    "00_Rock2-85-F_comp",
    "00_SS2-88-F_comp",
)
DEVELOPMENT_IDS = (
    "01_BN1-129-Eb_comp",
    "01_BN1-147-Gb_comp",
    "01_BN3-119-G_comp",
    "01_BN3-154-E_comp",
    "01_Funk1-114-Ab_comp",
    "01_Funk1-97-C_comp",
    "01_Funk3-112-C#_comp",
    "01_Funk3-98-A_comp",
    "01_Jazz1-130-D_comp",
    "01_Jazz1-200-B_comp",
    "01_Jazz3-137-Eb_comp",
    "01_Jazz3-150-C_comp",
    "01_Rock1-130-A_comp",
    "01_Rock1-90-C#_comp",
    "01_Rock3-117-Bb_comp",
    "01_Rock3-148-C_comp",
    "01_SS1-100-C#_comp",
    "01_SS1-68-E_comp",
    "01_SS3-84-Bb_comp",
    "01_SS3-98-C_comp",
    "02_BN1-129-Eb_comp",
    "02_BN1-147-Gb_comp",
    "02_BN3-119-G_comp",
    "02_BN3-154-E_comp",
    "02_Funk1-114-Ab_comp",
    "02_Funk1-97-C_comp",
    "02_Funk3-112-C#_comp",
    "02_Funk3-98-A_comp",
    "02_Jazz1-130-D_comp",
    "02_Jazz1-200-B_comp",
    "02_Jazz3-137-Eb_comp",
    "02_Jazz3-150-C_comp",
    "02_Rock1-130-A_comp",
    "02_Rock1-90-C#_comp",
    "02_Rock3-117-Bb_comp",
    "02_Rock3-148-C_comp",
    "02_SS1-100-C#_comp",
    "02_SS1-68-E_comp",
    "02_SS3-84-Bb_comp",
    "02_SS3-98-C_comp",
)
LOCKED_TEST_IDS = (
    "04_BN2-131-B_comp",
    "04_BN2-166-Ab_comp",
    "04_Funk2-108-Eb_comp",
    "04_Funk2-119-G_comp",
    "04_Jazz2-110-Bb_comp",
    "04_Jazz2-187-F#_comp",
    "04_Rock2-142-D_comp",
    "04_Rock2-85-F_comp",
    "04_SS2-107-Ab_comp",
    "04_SS2-88-F_comp",
    "05_BN2-131-B_comp",
    "05_BN2-166-Ab_comp",
    "05_Funk2-108-Eb_comp",
    "05_Funk2-119-G_comp",
    "05_Jazz2-110-Bb_comp",
    "05_Jazz2-187-F#_comp",
    "05_Rock2-142-D_comp",
    "05_Rock2-85-F_comp",
    "05_SS2-107-Ab_comp",
    "05_SS2-88-F_comp",
)
ERRATA_IDS = (
    "04_BN3-154-E_comp",
    "04_Jazz1-200-B_comp",
    "02_Funk2-119-G_comp",
)
TRIAD_SHORTHANDS = {"maj", "major", "min", "minor"}
SEVENTH_SHORTHANDS = {"7", "maj7", "min7"}
HDIM_CONFUSION_SHORTHANDS = {"min7", "7", "maj", "min", "major", "minor", "dim", "dim7"}
GAP_LIMIT_SECONDS = 2 * BEAT_WINDOW_SECONDS

METRIC_CONTRACT = {
    "exact": "Raw Harte string equality. No enharmonic rewrite and no seventh folding.",
    "enharmonic_shorthand": "Same root pitch class, shorthand, and bass. Spelling may differ. Extensions stay unmatched.",
    "root": "Root pitch class. Enharmonic spellings match. N matches neither a chord root.",
    "bare_triad_recall": "Among reference time whose shorthand is exactly maj or min, the prediction shorthand is that same triad. min7 does not count as min. This is not a major/minor swap rate.",
    "same_root_major_minor_swap": "Both shorthands are bare triads, the root pitch class matches, and the qualities differ.",
    "seventh_versus_triad": "Same root pitch class, reference shorthand is a bare triad, and prediction shorthand is 7, maj7, or min7. Reported separately and not added to the exact score.",
    "half_diminished_confusion": "Reference shorthand is hdim7 and the prediction is not the same shorthand and bass on the same root pitch class. Enharmonic hdim7 is not confusion.",
    "boundary": "Pair a reference segment only when a prediction shares its root pitch class and covers at least half of it. Unmatched segments stay out of the mean and are counted.",
    "no_chord_false_positive": "Reference is a chord and the prediction is N.",
    "beats": "70 ms one-to-one. The BACKEND-04I greedy matcher is always reported. When either series has a gap at or under 140 ms, the official count is a deterministic maximum-cardinality matching.",
    "aggregates": "Macro is the unweighted mean of per-recording scores. Duration-weighted chord scores sum time. Micro beat scores pool counts. Styles are aggregated the same way.",
    "ground_truth": "Lead-sheet JAMS layer for chords. beat_position for beats. Tempo annotation for BPM error. Labels are not supplied to the models.",
}


def parse_recording_id(recording_id: str) -> dict:
    player, rest = recording_id.split("_", 1)
    style = None
    for code in ("Funk", "Jazz", "Rock", "BN", "SS"):
        if rest.startswith(code):
            style = code
            rest = rest[len(code):]
            break
    if style is None or player not in {f"{index:02d}" for index in range(6)}:
        raise ValueError(recording_id)
    progression, bpm, key = rest.split("-", 2)
    if not progression.isdigit() or not bpm.isdigit() or not key.endswith("_comp"):
        raise ValueError(recording_id)
    return {
        "id": recording_id,
        "player": player,
        "style_code": style,
        "progression": progression,
        "filename_bpm": int(bpm),
        "filename_key": key[: -len("_comp")],
        "version": "comp",
    }


def assert_split_integrity() -> None:
    diagnostic = set(DIAGNOSTIC_IDS)
    development = set(DEVELOPMENT_IDS)
    locked = set(LOCKED_TEST_IDS)
    errata = set(ERRATA_IDS)
    if diagnostic & development or diagnostic & locked or development & locked:
        raise SystemExit("split overlap")
    if errata & development or errata & locked or errata & diagnostic:
        raise SystemExit("errata entered a scored split")
    if len(DEVELOPMENT_IDS) != 40 or len(LOCKED_TEST_IDS) != 20 or len(DIAGNOSTIC_IDS) != 5:
        raise SystemExit("unexpected split size")
    for recording_id in (*DIAGNOSTIC_IDS, *DEVELOPMENT_IDS, *LOCKED_TEST_IDS):
        parsed = parse_recording_id(recording_id)
        if recording_id in DEVELOPMENT_IDS and (parsed["player"] not in {"01", "02"} or parsed["progression"] not in {"1", "3"}):
            raise SystemExit(f"development rule failed for {recording_id}")
        if recording_id in LOCKED_TEST_IDS and (parsed["player"] not in {"04", "05"} or parsed["progression"] != "2"):
            raise SystemExit(f"locked-test rule failed for {recording_id}")
        if recording_id in DIAGNOSTIC_IDS and (parsed["player"] != "00" or parsed["progression"] != "2"):
            raise SystemExit(f"diagnostic rule failed for {recording_id}")


def _slices(reference, predicted, duration: float):
    boundaries = {0.0, float(duration)}
    for segment in list(reference) + list(predicted):
        boundaries.add(min(float(duration), max(0.0, float(segment["start"]))))
        boundaries.add(min(float(duration), max(0.0, float(segment["end"]))))
    points = sorted(boundaries)
    for start, end in zip(points, points[1:]):
        if end <= start:
            continue
        midpoint = (start + end) / 2.0
        yield end - start, label_at(reference, midpoint, duration), label_at(predicted, midpoint, duration)


def chord_extensions(reference, predicted, duration: float) -> dict:
    seventh = 0.0
    swap = 0.0
    hdim_reference = 0.0
    hdim_kept = 0.0
    hdim_confused = 0.0
    hdim_named = 0.0
    no_chord_false_positive = 0.0
    no_chord_false_negative = 0.0
    for width, expected, predicted_label in _slices(reference, predicted, duration):
        left = parse_harte(expected)
        right = parse_harte(predicted_label)
        same_root = (
            left["kind"] == "chord"
            and right["kind"] == "chord"
            and PITCH_CLASS.get(left["root"]) is not None
            and PITCH_CLASS.get(left["root"]) == PITCH_CLASS.get(right["root"])
        )
        if left["shorthand"] in TRIAD_SHORTHANDS and same_root and right["shorthand"] in SEVENTH_SHORTHANDS:
            seventh += width
        left_bucket = "major" if left["shorthand"] in {"maj", "major"} else "minor" if left["shorthand"] in {"min", "minor"} else None
        right_bucket = "major" if right["shorthand"] in {"maj", "major"} else "minor" if right["shorthand"] in {"min", "minor"} else None
        if same_root and left_bucket and right_bucket and left_bucket != right_bucket:
            swap += width
        if left["shorthand"] == "hdim7":
            hdim_reference += width
            kept = same_root and right["shorthand"] == "hdim7" and left["bass"] == right["bass"]
            if kept:
                hdim_kept += width
            else:
                hdim_confused += width
                if right["shorthand"] in HDIM_CONFUSION_SHORTHANDS:
                    hdim_named += width
        if left["kind"] == "chord" and right["kind"] == "none":
            no_chord_false_positive += width
        if left["kind"] == "none" and right["kind"] == "chord":
            no_chord_false_negative += width
    return {
        "seventh_versus_triad_seconds": round(seventh, 6),
        "same_root_major_minor_swap_seconds": round(swap, 6),
        "half_diminished_reference_seconds": round(hdim_reference, 6),
        "half_diminished_kept_seconds": round(hdim_kept, 6),
        "half_diminished_confusion_seconds": round(hdim_confused, 6),
        "half_diminished_named_substitution_seconds": round(hdim_named, 6),
        "no_chord_false_positive_seconds": round(no_chord_false_positive, 6),
        "no_chord_false_negative_seconds": round(no_chord_false_negative, 6),
    }


def _gap(times) -> float:
    ordered = sorted(float(value) for value in times)
    if len(ordered) < 2:
        return None
    return min(right - left for left, right in zip(ordered, ordered[1:]))


def maximum_cardinality_match(reference, detected, window: float) -> dict:
    """Deterministic Kuhn matching. Edges are detection-time order."""
    reference = [float(value) for value in reference]
    detected = [float(value) for value in detected]
    edges = []
    for ref_index, instant in enumerate(reference):
        partners = [det_index for det_index, candidate in enumerate(detected) if abs(candidate - instant) <= window]
        edges.append(partners)
    match_to_reference = [-1] * len(detected)

    def search(ref_index: int, seen: list) -> bool:
        for det_index in edges[ref_index]:
            if seen[det_index]:
                continue
            seen[det_index] = True
            prior = match_to_reference[det_index]
            if prior == -1 or search(prior, seen):
                match_to_reference[det_index] = ref_index
                return True
        return False

    for ref_index in range(len(reference)):
        search(ref_index, [False] * len(detected))
    errors = []
    for det_index, ref_index in enumerate(match_to_reference):
        if ref_index >= 0:
            errors.append(abs(detected[det_index] - reference[ref_index]))
    hits = len(errors)
    precision = hits / len(detected) if detected else 0.0
    recall = hits / len(reference) if reference else 0.0
    f_measure = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "reference": len(reference),
        "detected": len(detected),
        "matched": hits,
        "extra": len(detected) - hits,
        "missed": len(reference) - hits,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f_measure": round(f_measure, 6),
        "mean_abs_seconds": mean(errors),
        "max_abs_seconds": None if not errors else round(max(errors), 6),
        "matcher": "maximum_cardinality_kuhn",
    }


def score_beats(reference, detected, annotation_bpm) -> dict:
    greedy = match_events(reference, detected, BEAT_WINDOW_SECONDS)
    greedy["matcher"] = "greedy_04i"
    optimal = maximum_cardinality_match(reference, detected, BEAT_WINDOW_SECONDS)
    reference_gap = _gap(reference)
    detected_gap = _gap(detected)
    wide = (reference_gap is None or reference_gap > GAP_LIMIT_SECONDS) and (
        detected_gap is None or detected_gap > GAP_LIMIT_SECONDS
    )
    assumption = wide and greedy["matched"] == optimal["matched"]
    official = greedy if assumption else optimal
    return {
        "assumption_holds": assumption,
        "reference_min_gap_seconds": None if reference_gap is None else round(reference_gap, 6),
        "detected_min_gap_seconds": None if detected_gap is None else round(detected_gap, 6),
        "greedy": greedy,
        "optimal": optimal,
        "official": official,
        "phase": beat_phase(reference, detected, annotation_bpm),
    }


def score_recording(lead, predicted, reference_beats, detected_beats, annotation_bpm, duration: float, vocabulary_time: float) -> dict:
    slices = time_slices(lead, predicted, duration)
    totals = slices["totals"]
    extensions = chord_extensions(lead, predicted, duration)
    boundaries = boundary_errors(lead, predicted)
    boundaries.pop("pairs", None)
    return {
        "exact_accuracy": round(totals["exact"] / duration, 6) if duration else None,
        "enharmonic_shorthand_accuracy": round((totals["exact"] + totals.get("enharmonic", 0.0)) / duration, 6) if duration else None,
        "root_accuracy": round(slices["root_match"] / duration, 6) if duration else None,
        "bare_triad_recall": round(slices["major_minor_hit"] / slices["major_minor_ref"], 6) if slices["major_minor_ref"] else None,
        "bare_triad_reference_seconds": round(slices["major_minor_ref"], 6),
        "submission_vocabulary_coverage": round(vocabulary_time / duration, 6) if duration else None,
        "disagreement_seconds": {key: round(value, 6) for key, value in totals.items()},
        **extensions,
        "boundaries": boundaries,
        "beats": score_beats(reference_beats, detected_beats, annotation_bpm),
        "bpm_annotation": annotation_bpm,
    }


def _weighted(results, key: str) -> float:
    duration = sum(item["scored_duration_seconds"] for item in results)
    if not duration:
        return None
    return round(sum((item["metrics"][key] or 0.0) * item["scored_duration_seconds"] for item in results) / duration, 6)


def _seconds(results, key: str) -> float:
    return round(sum(item["metrics"][key] for item in results), 6)


def aggregate_recordings(results: list) -> dict:
    duration = sum(item["scored_duration_seconds"] for item in results)
    triad_reference = sum(item["metrics"]["bare_triad_reference_seconds"] for item in results)
    triad_hits = sum(
        (item["metrics"]["bare_triad_recall"] or 0.0) * item["metrics"]["bare_triad_reference_seconds"]
        for item in results
    )
    beat_hits = beat_reference = beat_detected = 0
    timing = []
    for item in results:
        official = item["metrics"]["beats"]["official"]
        beat_hits += official["matched"]
        beat_reference += official["reference"]
        beat_detected += official["detected"]
        if official["mean_abs_seconds"] is not None:
            timing.append(official["mean_abs_seconds"])
    precision = beat_hits / beat_detected if beat_detected else 0.0
    recall = beat_hits / beat_reference if beat_reference else 0.0
    f_measure = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    bpm_errors = [item["metrics"]["bpm_error"] for item in results if item["metrics"].get("bpm_error") is not None]
    half = [item["metrics"]["beats"]["phase"].get("fraction_near_half_beat") for item in results]
    return {
        "recordings": len(results),
        "scored_duration_seconds": round(duration, 6),
        "macro_exact_accuracy": macro([item["metrics"]["exact_accuracy"] for item in results]),
        "duration_weighted_exact_accuracy": _weighted(results, "exact_accuracy"),
        "macro_enharmonic_shorthand_accuracy": macro([item["metrics"]["enharmonic_shorthand_accuracy"] for item in results]),
        "duration_weighted_enharmonic_shorthand_accuracy": _weighted(results, "enharmonic_shorthand_accuracy"),
        "macro_root_accuracy": macro([item["metrics"]["root_accuracy"] for item in results]),
        "duration_weighted_root_accuracy": _weighted(results, "root_accuracy"),
        "macro_bare_triad_recall": macro([item["metrics"]["bare_triad_recall"] for item in results]),
        "duration_weighted_bare_triad_recall": round(triad_hits / triad_reference, 6) if triad_reference else None,
        "same_root_major_minor_swap_seconds": _seconds(results, "same_root_major_minor_swap_seconds"),
        "seventh_versus_triad_seconds": _seconds(results, "seventh_versus_triad_seconds"),
        "half_diminished_reference_seconds": _seconds(results, "half_diminished_reference_seconds"),
        "half_diminished_confusion_seconds": _seconds(results, "half_diminished_confusion_seconds"),
        "no_chord_false_positive_seconds": _seconds(results, "no_chord_false_positive_seconds"),
        "macro_boundary_mean_abs_seconds": macro([item["metrics"]["boundaries"]["mean_abs_seconds"] for item in results]),
        "unmatched_reference_segments": sum(item["metrics"]["boundaries"]["unmatched"] for item in results),
        "reference_segments": sum(item["metrics"]["boundaries"]["reference_segments"] for item in results),
        "micro_beat_precision": round(precision, 6),
        "micro_beat_recall": round(recall, 6),
        "micro_beat_f_measure": round(f_measure, 6),
        "macro_beat_f_measure": macro([item["metrics"]["beats"]["official"]["f_measure"] for item in results]),
        "macro_matched_beat_abs_seconds": mean(timing),
        "macro_half_beat_fraction": macro(half),
        "macro_bpm_error": macro(bpm_errors),
        "median_bpm_error": None if not bpm_errors else round(sorted(bpm_errors)[len(bpm_errors) // 2], 6),
        "min_bpm_error": None if not bpm_errors else round(min(bpm_errors), 6),
        "max_bpm_error": None if not bpm_errors else round(max(bpm_errors), 6),
        "extra_beats": sum(item["metrics"]["beats"]["official"]["extra"] for item in results),
        "missed_beats": sum(item["metrics"]["beats"]["official"]["missed"] for item in results),
        "greedy_assumption_failures": sum(1 for item in results if not item["metrics"]["beats"]["assumption_holds"]),
    }


def aggregate_by_style(results: list) -> dict:
    grouped = {}
    for item in results:
        grouped.setdefault(item["style_code"], []).append(item)
    return {style: aggregate_recordings(grouped[style]) for style in sorted(grouped)}
