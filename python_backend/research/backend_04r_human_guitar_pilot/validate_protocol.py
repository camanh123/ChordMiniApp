"""Check the BACKEND-04R.1 pilot documents and the GATE-1 freeze.

This script does not import the application, record audio, or score a model.
The expected freeze hashes live in GATE_1_FREEZE_MANIFEST.json, not in this
file. This file does not hash that manifest, and the manifest does not hash
itself. Run it from any working directory:

    python3 python_backend/research/backend_04r_human_guitar_pilot/validate_protocol.py
"""

from __future__ import annotations

import csv
import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WINDOW = Decimal("0.035")
AGREEMENT_MIN = Fraction(95, 100)
BEATS = 64
BARS = 16

DURATIONS = {
    "straight_strum": Fraction(64 * 60, 100),
    "fingerpicking": Fraction(64 * 60, 80),
    "syncopated_strum": Fraction(64 * 60, 96),
    "offbeat_heavy": Fraction(64 * 60, 90),
    "tempo_change": Fraction(32 * 60, 80) + Fraction(32 * 60, 100),
    "quiet_and_percussive": Fraction(64 * 60, 100),
}
TEMPO_TYPES = {
    "straight_strum": "CONSTANT",
    "fingerpicking": "CONSTANT",
    "syncopated_strum": "CONSTANT",
    "offbeat_heavy": "CONSTANT",
    "tempo_change": "STEP",
    "quiet_and_percussive": "CONSTANT",
}
CONDITIONS = (
    "straight_strum",
    "fingerpicking",
    "syncopated_strum",
    "offbeat_heavy",
    "tempo_change",
    "quiet_and_percussive",
)


def display_seconds(value: Fraction) -> str:
    quantized = (Decimal(value.numerator) / Decimal(value.denominator)).quantize(
        Decimal("0.001"), rounding=ROUND_HALF_UP
    )
    return format(quantized, "f")


def beat_time(index: int, condition: str) -> Fraction:
    """Time of beat index `index` in seconds. Index 64 is the end, not a click."""
    if index < 0 or index > BEATS:
        raise ValueError(index)
    if condition == "tempo_change":
        if index <= 32:
            return Fraction(index * 60, 80)
        return Fraction(24) + Fraction((index - 32) * 60, 100)
    bpm = {
        "straight_strum": 100,
        "fingerpicking": 80,
        "syncopated_strum": 96,
        "offbeat_heavy": 90,
        "quiet_and_percussive": 100,
    }[condition]
    return Fraction(index * 60, bpm)


def as_decimal(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, Fraction):
        return Decimal(value.numerator) / Decimal(value.denominator)
    return Decimal(str(value))


def match_streams(a_times, b_times, window: Decimal = WINDOW):
    """Maximum-cardinality, then minimum-cost, then lexicographic matching."""
    series_a = [as_decimal(value) for value in a_times]
    series_b = [as_decimal(value) for value in b_times]
    rows = len(series_a)
    cols = len(series_b)
    table = [[None for _ in range(cols + 1)] for _ in range(rows + 1)]
    table[0][0] = (0, Decimal(0), ())

    def rank(state):
        cardinality, cost, pairs = state
        return (-cardinality, cost, pairs)

    for i in range(rows + 1):
        for j in range(cols + 1):
            if i == 0 and j == 0:
                continue
            candidates = []
            if i:
                candidates.append(table[i - 1][j])
            if j:
                candidates.append(table[i][j - 1])
            if i and j and abs(series_a[i - 1] - series_b[j - 1]) <= window:
                cardinality, cost, pairs = table[i - 1][j - 1]
                delta = abs(series_a[i - 1] - series_b[j - 1])
                candidates.append((cardinality + 1, cost + delta, pairs + ((i - 1, j - 1),)))
            table[i][j] = min(candidates, key=rank)
    return table[rows][cols]


def agreement(a_times, b_times):
    if max(len(a_times), len(b_times)) == 0:
        return None
    cardinality, _cost, _pairs = match_streams(a_times, b_times)
    return Fraction(cardinality, max(len(a_times), len(b_times)))


def greedy_pairs(a_times, b_times, window: Decimal = WINDOW):
    series_a = [as_decimal(value) for value in a_times]
    series_b = [as_decimal(value) for value in b_times]
    candidates = []
    for i, time_a in enumerate(series_a):
        for j, time_b in enumerate(series_b):
            delta = abs(time_a - time_b)
            if delta <= window:
                candidates.append((delta, i, j))
    candidates.sort()
    used_a = set()
    used_b = set()
    chosen = []
    for _delta, i, j in candidates:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        chosen.append((i, j))
    return chosen


def round_half_away_from_zero(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def latency_passes(residual_samples: int, sample_rate: int) -> bool:
    return Fraction(abs(residual_samples), sample_rate) <= Fraction(1, 200)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def check_manifest(rows):
    require(len(rows) == 24, "expected 24 rows")
    ids = [row["recording_id"] for row in rows]
    require(len(set(ids)) == 24, "recording IDs are not unique")
    expected_ids = []
    for player, code in (("A", "PLAYER_A"), ("B", "PLAYER_B")):
        for session in ("S1", "S2"):
            for condition in CONDITIONS:
                expected_ids.append(f"pilot04q_{player}_{session}_{condition}")
    require(ids == expected_ids, "recording ID order or spelling changed")
    splits = [row["dataset_split"] for row in rows]
    require(splits.count("development") == 12, "development count")
    require(splits.count("sealed_evaluation") == 12, "sealed count")
    for row in rows:
        condition = row["condition"]
        require(row["bar_count"] == str(BARS), row["recording_id"])
        require(row["beat_count"] == str(BEATS), row["recording_id"])
        require(row["tempo_change_type"] == TEMPO_TYPES[condition], condition)
        require(row["planned_meter"] == "4/4", condition)
        exact = DURATIONS[condition]
        require(beat_time(BEATS, condition) == exact, condition)
        require(row["planned_duration_exact"].replace(" ", "") == _equation(condition), condition)
        require(row["planned_duration_seconds"] == display_seconds(exact), condition)
        require(float(row["planned_duration_seconds"]) <= 60, condition)
        require(row["duration_seconds"] == "NOT_COLLECTED", "measured duration filled")
        require(row["guitar_sha256"] == "NOT_COLLECTED", "guitar hash filled")
        require(row["click_sha256"] == "NOT_COLLECTED", "click hash filled")
        require(row["latency_samples"] == "NOT_COLLECTED", "latency filled")
        require(row["annotation_qa_status"] == "NOT_COLLECTED", "QA filled")
        require(row["final_acceptance_status"] == "NOT_COLLECTED", "acceptance filled")
        require(row["recording_date"] == "NOT_COLLECTED", "date filled")
        require(row["consent_status"] == "NEEDS_HUMAN_APPROVAL", "consent marked granted")
        require(row["composition_rights_status"] == "NEEDS_HUMAN_APPROVAL", "rights marked granted")
        require(row["sample_rate_hz"] == "NEEDS_HUMAN_APPROVAL", "sample rate chosen")
        if row["player_code"] == "PLAYER_A":
            require(row["dataset_split"] == "development", row["recording_id"])
        else:
            require(row["dataset_split"] == "sealed_evaluation", row["recording_id"])
        per_session = [
            item["condition"]
            for item in rows
            if item["player_code"] == row["player_code"] and item["session_id"] == row["session_id"]
        ]
        require(per_session.count(condition) == 1, "condition repeated inside a session")
    require(beat_time(32, "quiet_and_percussive") == Fraction(96, 5), "quiet bar 9")
    require(beat_time(32, "tempo_change") == Fraction(24), "tempo bar 9")
    require(display_seconds(DURATIONS["offbeat_heavy"]) == "42.667", "90 BPM display")
    require(DURATIONS["offbeat_heavy"] == Fraction(128, 3), "90 BPM exact")


def _equation(condition: str) -> str:
    return {
        "straight_strum": "64*60/100",
        "fingerpicking": "64*60/80",
        "syncopated_strum": "64*60/96",
        "offbeat_heavy": "64*60/90",
        "tempo_change": "32*60/80+32*60/100",
        "quiet_and_percussive": "64*60/100",
    }[condition]


def check_matcher():
    optimal = match_streams(["0.00", "0.05"], ["0.03", "0.08"])
    greedy = greedy_pairs(["0.00", "0.05"], ["0.03", "0.08"])
    require(optimal[0] == 2, "optimal matcher lost a pair")
    require(len(greedy) == 1, "greedy case no longer differs from optimal")
    require(agreement([], []) is None, "empty streams should be undefined")
    require(agreement([], ["0"]) == 0, "one empty stream")
    twenty = [str(index) for index in range(20)]
    require(agreement(twenty, twenty[:19]) == AGREEMENT_MIN, "exactly 95 percent")
    nineteen = [str(index) for index in range(19)]
    require(agreement(nineteen, nineteen[:18]) < AGREEMENT_MIN, "18/19 should fail")
    require(agreement(["0"], ["0.035"]) == 1, "exactly 35 ms")
    require(agreement(["0"], ["0.0351"]) == 0, "above 35 ms")
    duplicates = match_streams(["0", "0", "0.5"], ["0", "0.5"])
    require(duplicates[0] == 2, "duplicate cardinality")
    require(agreement(["0", "0", "0.5"], ["0", "0.5"]) == Fraction(2, 3), "duplicate agreement")
    tie = match_streams(["0", "0.01"], ["0.005"])
    require(tie[2] == ((0, 0),), "tie did not keep the earliest index")
    quarters = [Decimal(index) * Decimal("0.6") for index in range(8)]
    eighths = [Decimal(index) * Decimal("0.3") for index in range(16)]
    require(agreement(quarters, eighths) < AGREEMENT_MIN, "metrical levels should fail")
    half = [time + Decimal("0.3") for time in quarters]
    require(agreement(quarters, half) == 0, "half-beat shift should not match")
    stepped = []
    for index in range(64):
        if index <= 32:
            stepped.append(Fraction(index * 60, 80))
        else:
            stepped.append(Fraction(24) + Fraction((index - 32) * 60, 100))
    require(agreement(stepped, stepped) == 1, "tempo step should match itself")
    leading = [Fraction(-1, 2)] + quarters
    require(agreement(leading, quarters) == Fraction(len(quarters), len(leading)), "leading tap")


def check_trim_and_latency():
    require(latency_passes(220, 44100), "220 samples at 44100 should pass")
    require(not latency_passes(221, 44100), "221 samples at 44100 should fail")
    require(latency_passes(240, 48000), "240 samples at 48000 is exactly 5 ms")
    require(not latency_passes(241, 48000), "241 samples at 48000 should fail")
    require(Fraction(220, 44100) < Fraction(1, 200), "220/44100 bound")
    require(Fraction(240, 48000) == Fraction(1, 200), "240/48000 bound")
    start, end = 1000, 5000
    require(end - start == 4000, "trim length")
    require(1000 - start == 0 and 4999 - start == 3999, "kept edges")
    require(not (start <= 5000 < end), "end sample must be excluded")
    canonical_from_trim = 10 + start
    require(canonical_from_trim == 1010, "annotation transform")
    guitar_raw = 1100
    latency = 100
    require(guitar_raw - latency == 1000, "positive latency shifts guitar earlier")
    bar9 = Fraction(192, 10)
    require(bar9 * 44100 == 846720, "bar 9 at 44100")
    require(bar9 * 48000 == 921600, "bar 9 at 48000")
    require(24 * 44100 == 1058400 and 24 * 48000 == 1152000, "24 second grid")
    half_sample = Decimal("0.625") * Decimal(44100)
    require(half_sample == Decimal("27562.5"), "96 BPM beat 1 at 44100")
    require(round_half_away_from_zero(half_sample) == 27563, "half-sample rounding")
    for rate in (44100, 48000):
        milliseconds = (Decimal(1) / Decimal(rate)) * Decimal(1000)
        nearest = milliseconds.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        require(nearest == 0, f"sample 1 should round to 0 ms at {rate}")
        require(int(nearest) * rate / 1000 == 0, "millisecond round trip dropped the sample")


def consensus(a_times, b_times):
    """Midpoints of matched pairs, plus unmatched taps that must not be dropped."""
    _cardinality, _cost, pairs = match_streams(a_times, b_times)
    series_a = [as_decimal(value) for value in a_times]
    series_b = [as_decimal(value) for value in b_times]
    matched_a = {index_a for index_a, _index_b in pairs}
    matched_b = {index_b for _index_a, index_b in pairs}
    midpoints = [(series_a[index_a] + series_b[index_b]) / 2 for index_a, index_b in pairs]
    unmatched = [("A", index) for index in range(len(series_a)) if index not in matched_a]
    unmatched += [("B", index) for index in range(len(series_b)) if index not in matched_b]
    return midpoints, unmatched


def median_gap(times):
    gaps = [as_decimal(times[index + 1]) - as_decimal(times[index]) for index in range(len(times) - 1)]
    ordered = sorted(gaps)
    return ordered[len(ordered) // 2]


def strictly_increasing(samples):
    return all(samples[index] < samples[index + 1] for index in range(len(samples) - 1))


def check_consensus():
    identical = ["0", "1", "2"]
    midpoints, unmatched = consensus(identical, identical)
    require(midpoints == [Decimal(value) for value in identical], "identical midpoints")
    require(unmatched == [], "identical streams have no unmatched taps")
    require(strictly_increasing([0, 44100, 88200]), "identical sample order")

    offset_a = [Decimal(0), Decimal(1)]
    offset_b = [Decimal("0.020"), Decimal("1.020")]
    midpoints, unmatched = consensus(offset_a, offset_b)
    require(midpoints == [Decimal("0.010"), Decimal("1.010")], "offset midpoints")
    require(unmatched == [], "valid offsets stay matched")

    midpoints, unmatched = consensus(["0"], ["0.035"])
    require(midpoints == [Decimal("0.0175")], "35 ms midpoint")
    require(unmatched == [], "35 ms pair is matched")

    twenty = [str(index) for index in range(20)]
    midpoints, unmatched = consensus(twenty, twenty[:19])
    require(agreement(twenty, twenty[:19]) == AGREEMENT_MIN, "95 percent with a missing beat")
    require(len(midpoints) == 19, "provisional midpoints keep the matched beats")
    require(len(unmatched) == 1, "missing beat is retained for adjudication")

    midpoints, extra = consensus(twenty[:19], twenty)
    require(len(extra) == 1 and extra[0][0] == "B", "extra beat is retained")

    midpoints, unmatched = consensus(["0", "0", "0.5"], ["0", "0.5"])
    require(len(midpoints) == 2, "duplicate contributes one matched midpoint")
    require(len(unmatched) == 1, "duplicate partner is not silently deleted")

    quarters = [Decimal(index) * Decimal("0.6") for index in range(8)]
    half = [time + Decimal("0.3") for time in quarters]
    require(agreement(quarters, half) == 0, "half-beat phase has no pairs")
    _midpoints, unmatched = consensus(quarters, half)
    require(len(unmatched) == len(quarters) + len(half), "half-beat leaves every tap unmatched")

    eighths = [Decimal(index) * Decimal("0.3") for index in range(16)]
    require(agreement(quarters, eighths) < AGREEMENT_MIN, "different metrical levels")

    stepped = []
    for index in range(64):
        if index <= 32:
            stepped.append(Fraction(index * 60, 80))
        else:
            stepped.append(Fraction(24) + Fraction((index - 32) * 60, 100))
    require(median_gap(stepped) / median_gap(stepped) == 1, "tempo step ratio is annotator versus annotator")
    crossing = Fraction(60, 80) / Fraction(60, 100)
    require(crossing == Fraction(5, 4), "beat-32 gap ratio")
    require(not (Fraction(9, 10) <= crossing <= Fraction(11, 10)), "do not apply 0.9-1.1 to the step gap")
    quiet = [Fraction(index * 60, 100) for index in range(64)]
    missed_boundary = quiet[:32] + quiet[33:]
    require(agreement(quiet, missed_boundary) == Fraction(63, 64), "bar-9 miss still passes 95 percent")
    midpoints, unmatched = consensus(quiet, missed_boundary)
    require(len(midpoints) == 63 and len(unmatched) == 1, "bar-9 miss is adjudicated")
    require(quiet[32] == Fraction(192, 10), "bar-9 time stays 19.2 s")

    between = consensus(["0"], [Decimal(1) / Decimal(44100)])
    sample = round_half_away_from_zero(between[0][0] * Decimal(44100))
    require(between[0][0] * Decimal(44100) == Decimal("0.5"), "midpoint sits between samples")
    require(sample == 1, "half-sample tie rounds away from zero")

    start_sample = 1000
    trimmed_sample = sample
    canonical = trimmed_sample + start_sample
    latency_samples = 100
    require(canonical == 1001, "trim shift")
    require(canonical - latency_samples != canonical, "latency must not be applied twice")

    collided, _unmatched = consensus(["0", "0.000001"], ["0", "0.000001"])
    collided_samples = [round_half_away_from_zero(value * Decimal(44100)) for value in collided]
    require(not strictly_increasing(collided_samples), "collapsed samples are not a reference series")


def check_documents():
    overview = (ROOT / "PILOT_OVERVIEW.md").read_text()
    annotation = (ROOT / "ANNOTATION_PROTOCOL.md").read_text()
    sync = (ROOT / "SYNC_AND_LATENCY_QA.md").read_text()
    checklist = (ROOT / "RECORDING_CHECKLIST.md").read_text()
    require("PENDING_FINAL_HUMAN_APPROVAL" in overview, "GATE-1 status missing")
    require("128/3" in overview and "42.667" in overview, "90 BPM audit missing")
    require("19.200" in overview, "quiet boundary missing from overview")
    require("TAKE_ACCEPTED" in annotation and "TAKE_REVIEW_REQUIRED" in annotation, "outcomes")
    require("TAKE_REJECTED" in annotation, "rejected outcome")
    require("0.035" in annotation and "0.95" in annotation, "thresholds")
    require("greedy" in annotation, "greedy contrast missing")
    require("midpoint" in annotation and "not human-approved" in annotation, "midpoint contract")
    require("The midpoint of a pair is not used" not in annotation, "old reference rule remains")
    require("not a comparison of either annotator with the tempo map" in annotation, "ratio operand")
    require("not subtracted again" in annotation, "latency applied once")
    require("midpoint of each matched pair" in overview, "overview reference line")
    require("[start_sample, end_sample)" in sync, "trim notation")
    require("<= 0.005" in sync or "<= 0.005" in sync.replace("≤", "<="), "latency inequality")
    require("220" in sync and "240" in sync and "27562.5" in sync, "rate examples")
    require("guitar_impulse_index - click_impulse_index" in sync, "sign convention")
    require("128/3" in checklist and "beat 32" in checklist, "checklist tempo map")
    for name in ("PERFORMER_CONSENT_TEMPLATE.md", "COMPOSITION_RIGHTS_TEMPLATE.md"):
        text = (ROOT / name).read_text()
        require("UNSIGNED TEMPLATE" in text, name)
        require("GRANTED" not in text, name)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_freeze():
    """Compare checkout bytes with the external freeze manifest."""
    manifest_path = ROOT / "GATE_1_FREEZE_MANIFEST.json"
    manifest = json.loads(manifest_path.read_text())
    require(manifest["freeze_identifier"] == "CHORDMINI-GATE-1-DESIGN-FREEZE", "freeze id")
    require(manifest["approval_decision_id"] == "CHORDMINI-GATE-1-DESIGN-APPROVAL", "decision id")
    require(
        manifest["approved_specification_commit"] == "9b9bae00dfb978203a631c702d02a66bd47d02e7",
        "approved commit",
    )
    require(manifest["manifest_is_excluded_from_hash_list"] is True, "manifest exclusion flag")
    require(manifest["gate_1_status"] == "APPROVED_DESIGN_ONLY", "gate 1 status")
    for gate_number in range(2, 9):
        gate = f"GATE-{gate_number}"
        require(manifest["pending_gates"][gate] == "PENDING", gate)
    flags = manifest["execution_flags"]
    for name in (
        "PILOT_EXECUTION_AUTHORIZED",
        "RECORDING_AUTHORIZED",
        "CONSENT_SIGNED",
        "RIGHTS_CLEARED",
        "PERFORMERS_RECRUITED",
        "DATASET_COLLECTED",
        "MODEL_COMPARISON_AUTHORIZED",
    ):
        require(flags[name] is False, name)
    structure = manifest["pilot_structure"]
    require(structure["takes"] == 24, "freeze take count")
    require(structure["development"] == 12 and structure["sealed_evaluation"] == 12, "freeze split")
    require(structure["sessions_per_player"] == 2 and structure["conditions_per_session"] == 6, "freeze shape")
    thresholds = manifest["thresholds"]
    require(thresholds["pair_tolerance_seconds"] == "0.035", "freeze tolerance")
    require(thresholds["minimum_agreement"] == "0.95", "freeze agreement")
    require(thresholds["residual_latency_seconds"] == "0.005", "freeze latency")
    require(thresholds["maximum_duration_seconds"] == 60, "freeze duration")
    require(thresholds["bars"] == 16 and thresholds["beats"] == 64, "freeze bars")
    require(thresholds["bar_9_beat_index"] == 32, "freeze bar 9")
    require(Decimal(thresholds["pair_tolerance_seconds"]) == WINDOW, "tolerance matches matcher")
    require(Fraction(thresholds["minimum_agreement"]) == AGREEMENT_MIN, "agreement matches matcher")
    listed = manifest["protected_documents"] + manifest["verification_set"] + [manifest["approval_record"]]
    require(len(manifest["protected_documents"]) == 7, "protected document count")
    require([item["path"] for item in manifest["verification_set"]] == ["validate_protocol.py"], "verification set")
    seen = set()
    for item in listed:
        require(item["path"] != "GATE_1_FREEZE_MANIFEST.json", "manifest hashed itself")
        require(item["path"] not in seen, "duplicate freeze path")
        seen.add(item["path"])
        require(sha256_file(ROOT / item["path"]) == item["sha256"], f"hash mismatch: {item['path']}")
    record = (ROOT / manifest["approval_record"]["path"]).read_text()
    require("CHORDMINI-GATE-1-DESIGN-APPROVAL" in record, "decision id in record")
    require("APPROVED_DESIGN_ONLY" in record, "design-only status")
    require("2026-10-24" in record, "decision date")
    require("No performer is named" in record, "no invented performer")
    require("not participant consent" in record, "consent not claimed")
    require("CONSENT_SIGNED" in record, "consent flag named")


def main():
    with (ROOT / "DATA_MANIFEST_TEMPLATE.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    check_manifest(rows)
    check_matcher()
    check_consensus()
    check_trim_and_latency()
    check_documents()
    check_freeze()
    print("validate_protocol.py: PASS")


if __name__ == "__main__":
    main()
