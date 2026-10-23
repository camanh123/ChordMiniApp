"""BACKEND-04I evaluation of Madmom and Chord-CNN-LSTM on GuitarSet.

GuitarSet v1.1.0 is the Zenodo record 10.5281/zenodo.3371780, released under
Creative Commons Attribution 4.0 International. Cite Xi, Bittner, Pauwels,
Ye, and Bello, ISMIR 2018. This script does not redistribute the audio.
Extracted media stay under /tmp/chordmini-04i.

The five excerpt IDs are fixed by the selection rule in SELECTED. They were
chosen from filenames and the official JAMS chord annotations before any
model output was inspected.

This script does not change model weights, does not bind a public address,
and does not print the Flask credential.
"""

import hashlib
import http.client
import json
import os
import platform
import resource
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DIR = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

EVIDENCE_PATH = RESEARCH_DIR / "backend_04i_guitarset_evidence.json"
PRIOR_EVIDENCE_PATH = RESEARCH_DIR / "backend_04h_benchmark_evidence.json"
CORPUS = Path("/tmp/chordmini-04i")
ANNOTATION_ZIP = CORPUS / "annotation.zip"
ANNOTATION_MD5 = "b39b78e63d3446f2e54ddb7a54df9b10"
ANNOTATION_SHA256 = "8daa02e6417ccca1685feb44b135e95928ad7037e5032ecb326b5791856fda99"
AUDIO_ZIP_MD5 = "275966d6610ac34999b58426beb119c3"
BEAT_WINDOW_SECONDS = 0.07
TESTING_UPLOAD_CAP_BYTES = 5 * 1024 * 1024
SUBMISSION_LIST = BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "data" / "submission_chord_list.txt"

# Player 00, accompaniment, progression 2, slower of the two published tempi.
# Progression 2's lead-sheet symbols are the Autumn Leaves pattern. Known
# errata IDs (04_BN3-154-E_comp, 04_Jazz1-200-B_comp, 02_Funk2-119-G_comp)
# are outside this rule. Do not replace an ID after seeing model output.
SELECTED = (
    {
        "id": "00_BN2-131-B_comp",
        "style_code": "BN",
        "style": "Bossa Nova",
        "progression": "2",
        "player": "00",
        "version": "comp",
        "filename_bpm": 131,
        "filename_key": "B",
    },
    {
        "id": "00_Funk2-108-Eb_comp",
        "style_code": "Funk",
        "style": "Funk",
        "progression": "2",
        "player": "00",
        "version": "comp",
        "filename_bpm": 108,
        "filename_key": "Eb",
    },
    {
        "id": "00_Jazz2-110-Bb_comp",
        "style_code": "Jazz",
        "style": "Jazz",
        "progression": "2",
        "player": "00",
        "version": "comp",
        "filename_bpm": 110,
        "filename_key": "Bb",
    },
    {
        "id": "00_Rock2-85-F_comp",
        "style_code": "Rock",
        "style": "Rock",
        "progression": "2",
        "player": "00",
        "version": "comp",
        "filename_bpm": 85,
        "filename_key": "F",
    },
    {
        "id": "00_SS2-88-F_comp",
        "style_code": "SS",
        "style": "Singer-Songwriter",
        "progression": "2",
        "player": "00",
        "version": "comp",
        "filename_bpm": 88,
        "filename_key": "F",
    },
)

PITCH_CLASS = {
    "C": 0, "B#": 0,
    "C#": 1, "Db": 1,
    "D": 2,
    "D#": 3, "Eb": 3,
    "E": 4, "Fb": 4,
    "F": 5, "E#": 5,
    "F#": 6, "Gb": 6,
    "G": 7,
    "G#": 8, "Ab": 8,
    "A": 9,
    "A#": 10, "Bb": 10,
    "B": 11, "Cb": 11,
}
MAJOR_SHORTHAND = {"maj", "major"}
MINOR_SHORTHAND = {"min", "minor"}


def peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_one(name: str) -> Path:
    matches = [path for path in CORPUS.rglob(name) if path.is_file() and "audio_mono-mic.zip" not in str(path)]
    if len(matches) != 1:
        raise SystemExit(f"expected one {name} under {CORPUS}, found {len(matches)}")
    return matches[0]


def cpu_info() -> dict:
    model = None
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("model name"):
                model = line.split(":", 1)[1].strip()
                break
    return {
        "model": model,
        "logical_cpus": os.cpu_count(),
        "platform": platform.platform(),
        "python": platform.python_version(),
    }


def load_submission_labels() -> set:
    labels = set()
    for line in SUBMISSION_LIST.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if text:
            labels.add(text)
    return labels


def in_submission_vocabulary(label: str, vocabulary: set) -> bool:
    parsed = parse_harte(label)
    if parsed["kind"] == "none":
        return "N" in vocabulary or label in vocabulary
    root = "C"
    body = f"{root}:{parsed['shorthand']}"
    if parsed["bass"]:
        body = f"{body}/{parsed['bass']}"
    return body in vocabulary


def parse_harte(label: str) -> dict:
    text = str(label).strip()
    if text in {"N", "X", ""}:
        return {"kind": "none", "root": None, "shorthand": None, "bass": None, "raw": text or "N"}
    depth = 0
    bass_at = None
    for index, character in enumerate(text):
        if character == "(":
            depth += 1
        elif character == ")":
            depth = max(0, depth - 1)
        elif character == "/" and depth == 0:
            bass_at = index
    body = text
    bass = None
    if bass_at is not None:
        body = text[:bass_at]
        bass = text[bass_at + 1:]
    if ":" in body:
        root, shorthand = body.split(":", 1)
    else:
        root, shorthand = body, "maj"
    return {
        "kind": "chord",
        "root": root,
        "shorthand": shorthand,
        "bass": bass,
        "raw": text,
    }


def quality_bucket(parsed: dict) -> str:
    if parsed["kind"] == "none":
        return "none"
    shorthand = parsed["shorthand"] or ""
    if shorthand in MAJOR_SHORTHAND:
        return "major"
    if shorthand in MINOR_SHORTHAND:
        return "minor"
    return "other"


def rows_to_segments(rows: list) -> list:
    segments = []
    for row in rows:
        segments.append({
            "start": float(row["time"]),
            "end": float(row["time"]) + float(row["duration"]),
            "chord": str(row.get("value") or "N"),
        })
    return segments


def load_jams(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def chord_layers(jams: dict) -> dict:
    layers = [item for item in jams["annotations"] if item.get("namespace") == "chord"]
    performed = []
    lead = []
    for layer in layers:
        meta = layer.get("annotation_metadata") or {}
        source = str(meta.get("data_source") or "")
        version = str(meta.get("version") or "")
        if version == "0.9" or "Semi-automatic" in source:
            performed.append(layer)
        else:
            lead.append(layer)
    if len(performed) != 1 or len(lead) != 1:
        raise SystemExit(f"expected one lead-sheet and one performed chord layer, got {len(lead)} and {len(performed)}")
    return {"lead_sheet": lead[0], "performed_voicing": performed[0]}


def beat_reference(jams: dict) -> dict:
    layers = [item for item in jams["annotations"] if item.get("namespace") == "beat_position"]
    tempos = [item for item in jams["annotations"] if item.get("namespace") == "tempo"]
    if len(layers) != 1 or len(tempos) != 1:
        raise SystemExit("expected one beat_position layer and one tempo layer")
    beats = []
    downbeats = []
    for row in layers[0]["data"]:
        instant = float(row["time"])
        position = int(row["value"]["position"])
        beats.append(instant)
        if position == 1:
            downbeats.append(instant)
    tempo_rows = tempos[0]["data"]
    return {
        "beats": beats,
        "downbeats": downbeats,
        "tempo_events": [
            {
                "time": float(row["time"]),
                "duration": float(row["duration"]),
                "bpm": float(row["value"]),
                "confidence": row.get("confidence"),
            }
            for row in tempo_rows
        ],
    }


def note_count(jams: dict) -> int:
    return sum(len(item.get("data") or []) for item in jams["annotations"] if item.get("namespace") == "note_midi")


def label_at(segments, instant: float, duration: float) -> str:
    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        if start <= instant < end:
            return str(segment["chord"])
        if instant == duration and start < instant <= end:
            return str(segment["chord"])
    return "N"


def mean(values):
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def disagreement_kind(expected: str, predicted: str) -> str:
    if expected == predicted:
        return "exact"
    left = parse_harte(expected)
    right = parse_harte(predicted)
    if left["kind"] == "none" or right["kind"] == "none":
        return "no_chord"
    if PITCH_CLASS.get(left["root"]) is None or PITCH_CLASS.get(right["root"]) is None:
        return "root"
    if PITCH_CLASS[left["root"]] != PITCH_CLASS[right["root"]]:
        return "root"
    same_shorthand = left["shorthand"] == right["shorthand"] and left["bass"] == right["bass"]
    if same_shorthand and expected != predicted:
        return "enharmonic"
    if left["shorthand"] == right["shorthand"] and left["bass"] != right["bass"]:
        return "inversion"
    if quality_bucket(left) in {"major", "minor"} and quality_bucket(right) in {"major", "minor"} and quality_bucket(left) != quality_bucket(right):
        return "major_minor"
    return "quality_other"


def time_slices(reference, predicted, duration: float) -> dict:
    boundaries = {0.0, float(duration)}
    for segment in list(reference) + list(predicted):
        boundaries.add(min(float(duration), max(0.0, float(segment["start"]))))
        boundaries.add(min(float(duration), max(0.0, float(segment["end"]))))
    points = sorted(boundaries)
    totals = {
        "exact": 0.0,
        "enharmonic": 0.0,
        "no_chord": 0.0,
        "inversion": 0.0,
        "major_minor": 0.0,
        "quality_other": 0.0,
        "root": 0.0,
    }
    root_match = 0.0
    major_minor_ref = 0.0
    major_minor_hit = 0.0
    submission_time = 0.0
    pairs = {}
    for start, end in zip(points, points[1:]):
        if end <= start:
            continue
        width = end - start
        expected = label_at(reference, (start + end) / 2.0, duration)
        predicted_label = label_at(predicted, (start + end) / 2.0, duration)
        kind = disagreement_kind(expected, predicted_label)
        totals[kind] += width
        left = parse_harte(expected)
        right = parse_harte(predicted_label)
        if left["kind"] == "chord" and right["kind"] == "chord" and PITCH_CLASS.get(left["root"]) == PITCH_CLASS.get(right["root"]):
            root_match += width
        bucket = quality_bucket(left)
        if bucket in {"major", "minor"}:
            major_minor_ref += width
            if quality_bucket(right) == bucket:
                major_minor_hit += width
        key = (expected, predicted_label)
        pairs[key] = pairs.get(key, 0.0) + width
    return {
        "totals": totals,
        "root_match": root_match,
        "major_minor_ref": major_minor_ref,
        "major_minor_hit": major_minor_hit,
        "pairs": pairs,
        "submission_time": submission_time,
    }


def boundary_errors(reference, predicted) -> dict:
    paired = []
    unmatched = 0
    for expected in reference:
        width = expected["end"] - expected["start"]
        best = None
        best_overlap = 0.0
        expected_pc = PITCH_CLASS.get(parse_harte(expected["chord"])["root"])
        for candidate in predicted:
            if PITCH_CLASS.get(parse_harte(candidate["chord"])["root"]) != expected_pc:
                continue
            overlap = min(expected["end"], candidate["end"]) - max(expected["start"], candidate["start"])
            if overlap > best_overlap:
                best = candidate
                best_overlap = overlap
        justified = best is not None and width > 0 and best_overlap >= 0.5 * width
        if not justified:
            unmatched += 1
            continue
        paired.append({
            "chord": expected["chord"],
            "start_delta_seconds": round(best["start"] - expected["start"], 6),
            "end_delta_seconds": round(best["end"] - expected["end"], 6),
            "overlap_seconds": round(best_overlap, 6),
        })
    absolute = []
    for item in paired:
        absolute.append(abs(item["start_delta_seconds"]))
        absolute.append(abs(item["end_delta_seconds"]))
    return {
        "paired": len(paired),
        "unmatched": unmatched,
        "reference_segments": len(reference),
        "mean_abs_seconds": mean(absolute),
        "mean_abs_start_seconds": mean([abs(item["start_delta_seconds"]) for item in paired]),
        "mean_abs_end_seconds": mean([abs(item["end_delta_seconds"]) for item in paired]),
        "max_abs_seconds": None if not absolute else round(max(absolute), 6),
        "pairs": paired,
    }


def match_events(reference, detected, window: float) -> dict:
    used = set()
    errors = []
    for instant in reference:
        best_index = None
        best_error = None
        for index, candidate in enumerate(detected):
            if index in used:
                continue
            error = abs(candidate - instant)
            if error <= window and (best_error is None or error < best_error):
                best_index = index
                best_error = error
        if best_index is not None:
            used.add(best_index)
            errors.append(best_error)
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
    }


def audio_probe(path: Path) -> dict:
    import numpy as np
    import soundfile as sf

    info = sf.info(str(path))
    samples, rate = sf.read(str(path), always_2d=False)
    array = np.asarray(samples, dtype=np.float64)
    if array.ndim > 1:
        peak = float(np.max(np.abs(array)))
        channels = int(array.shape[1])
    else:
        peak = float(np.max(np.abs(array))) if array.size else 0.0
        channels = 1
    return {
        "soundfile_format": info.format,
        "soundfile_subtype": info.subtype,
        "sample_rate": int(info.samplerate),
        "channels": int(info.channels),
        "frames": int(info.frames),
        "duration_seconds": round(float(info.frames) / float(info.samplerate), 6),
        "decoded_channels_observed": channels,
        "peak_abs": round(peak, 6),
    }


def slim(result: dict) -> dict:
    keep = (
        "success", "beats", "downbeats", "bpm", "time_signature", "model_used",
        "model_name", "chords", "total_chords", "duration", "chord_dict",
        "processing_time", "error",
    )
    return {key: result.get(key) for key in keep if key in result}


def predicted_segments(chords: dict) -> list:
    return [
        {
            "start": float(row.get("start", 0.0)),
            "end": float(row.get("end", 0.0)),
            "chord": str(row.get("chord") or "N"),
        }
        for row in (chords.get("chords") or [])
    ]


def analyze_file(services, record: dict, vocabulary: set) -> dict:
    audio = find_one(f"{record['id']}_mic.wav")
    jams_path = find_one(f"{record['id']}.jams")
    jams = load_jams(jams_path)
    layers = chord_layers(jams)
    lead = rows_to_segments(layers["lead_sheet"]["data"])
    performed = rows_to_segments(layers["performed_voicing"]["data"])
    beats = beat_reference(jams)
    probe = audio_probe(audio)
    jams_duration = float(jams["file_metadata"]["duration"])
    scored = min(jams_duration, probe["duration_seconds"])
    boundary_delta = 0.0
    if len(lead) == len(performed):
        for left, right in zip(lead, performed):
            boundary_delta = max(boundary_delta, abs(left["start"] - right["start"]), abs(left["end"] - right["end"]))
    else:
        boundary_delta = None

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
    predicted = predicted_segments(chord_result)
    detected = [float(value) for value in (beat_result.get("beats") or [])]
    detected_down = [float(value) for value in (beat_result.get("downbeats") or [])]
    reference_beats = [instant for instant in beats["beats"] if instant <= scored + 1e-6]
    reference_down = [instant for instant in beats["downbeats"] if instant <= scored + 1e-6]
    lead_score = time_slices(lead, predicted, scored)
    performed_score = time_slices(performed, predicted, scored)
    lead_vocab_time = 0.0
    performed_vocab_time = 0.0
    for segment in lead:
        width = min(segment["end"], scored) - max(segment["start"], 0.0)
        if width > 0 and in_submission_vocabulary(segment["chord"], vocabulary):
            lead_vocab_time += width
    for segment in performed:
        width = min(segment["end"], scored) - max(segment["start"], 0.0)
        if width > 0 and in_submission_vocabulary(segment["chord"], vocabulary):
            performed_vocab_time += width
    tempo = beats["tempo_events"][0]["bpm"] if len(beats["tempo_events"]) == 1 else None
    detected_bpm = beat_result.get("bpm")
    ibis = [right - left for left, right in zip(reference_beats, reference_beats[1:])]
    median_ibi = sorted(ibis)[len(ibis) // 2] if ibis else None
    confidences = list(dict.fromkeys(str(row.get("confidence")) for row in (chord_result.get("chords") or [])))
    confusion = sorted(
        (
            {"reference": pair[0], "predicted": pair[1], "seconds": round(width, 6)}
            for pair, width in lead_score["pairs"].items()
            if pair[0] != pair[1]
        ),
        key=lambda item: item["seconds"],
        reverse=True,
    )[:8]
    combined = beat_seconds + chord_seconds
    return {
        "id": record["id"],
        "selection": record,
        "audio": {
            "path": str(audio),
            "bytes": audio.stat().st_size,
            "sha256": sha256(audio),
            "under_testing_upload_cap": audio.stat().st_size < TESTING_UPLOAD_CAP_BYTES,
            **probe,
        },
        "annotation": {
            "path": str(jams_path),
            "sha256": sha256(jams_path),
            "jams_duration_seconds": jams_duration,
            "scored_duration_seconds": round(scored, 6),
            "lead_sheet_rule": (layers["lead_sheet"].get("annotation_metadata") or {}).get("annotation_rules") or "",
            "performed_source": (layers["performed_voicing"].get("annotation_metadata") or {}).get("data_source"),
            "performed_rules": (layers["performed_voicing"].get("annotation_metadata") or {}).get("annotation_rules"),
            "lead_vs_performed_boundary_max_seconds": None if boundary_delta is None else round(boundary_delta, 6),
            "lead_sheet": lead,
            "note_midi_count": note_count(jams),
            "notes_per_second": round(note_count(jams) / jams_duration, 3) if jams_duration else None,
            "tempo_events": beats["tempo_events"],
            "median_inter_beat_seconds": None if median_ibi is None else round(median_ibi, 6),
            "bpm_from_median_inter_beat": None if not median_ibi else round(60.0 / median_ibi, 3),
        },
        "beat_wall_seconds": round(beat_seconds, 4),
        "chord_wall_seconds": round(chord_seconds, 4),
        "combined_wall_seconds": round(combined, 4),
        "real_time_factor": {
            "beat": round(beat_seconds / scored, 4) if scored else None,
            "chord": round(chord_seconds / scored, 4) if scored else None,
            "combined": round(combined / scored, 4) if scored else None,
        },
        "beats": slim(beat_result),
        "chords": slim(chord_result),
        "metrics": {
            "beats": match_events(reference_beats, detected, BEAT_WINDOW_SECONDS),
            "downbeats": match_events(reference_down, detected_down, BEAT_WINDOW_SECONDS),
            "bpm_annotation": tempo,
            "bpm_detected": detected_bpm,
            "bpm_error": None if tempo is None or detected_bpm is None else round(abs(float(detected_bpm) - tempo), 6),
            "lead_sheet": score_block(lead_score, scored, lead_vocab_time),
            "performed_voicing": score_block(performed_score, scored, performed_vocab_time),
            "lead_sheet_boundaries": boundary_errors(lead, predicted),
            "confusion_examples": confusion,
            "confidence_values": confidences,
        },
        "peak_memory_mb": round(peak_mb(), 2),
    }


def score_block(slices: dict, duration: float, vocabulary_time: float) -> dict:
    totals = slices["totals"]
    return {
        "exact_accuracy": round(totals["exact"] / duration, 6) if duration else None,
        "enharmonic_shorthand_accuracy": round((totals["exact"] + totals.get("enharmonic", 0.0)) / duration, 6) if duration else None,
        "root_accuracy": round(slices["root_match"] / duration, 6) if duration else None,
        "major_minor_accuracy": round(slices["major_minor_hit"] / slices["major_minor_ref"], 6) if slices["major_minor_ref"] else None,
        "major_minor_reference_seconds": round(slices["major_minor_ref"], 6),
        "major_minor_coverage": round(slices["major_minor_ref"] / duration, 6) if duration else None,
        "submission_vocabulary_coverage": round(vocabulary_time / duration, 6) if duration else None,
        "disagreement_seconds": {key: round(value, 6) for key, value in totals.items()},
    }


def macro(values):
    present = [value for value in values if value is not None]
    return mean(present)


def aggregate(results: list) -> dict:
    duration = sum(item["annotation"]["scored_duration_seconds"] for item in results)
    exact = 0.0
    root = 0.0
    major_hit_seconds = 0.0
    major_ref_seconds = 0.0
    beat_hits = 0
    beat_ref = 0
    beat_det = 0
    for item in results:
        width = item["annotation"]["scored_duration_seconds"]
        lead = item["metrics"]["lead_sheet"]
        exact += lead["exact_accuracy"] * width
        root += lead["root_accuracy"] * width
        major_ref_seconds += lead["major_minor_reference_seconds"]
        if lead["major_minor_accuracy"] is not None:
            major_hit_seconds += lead["major_minor_accuracy"] * lead["major_minor_reference_seconds"]
        beats = item["metrics"]["beats"]
        beat_hits += beats["matched"]
        beat_ref += beats["reference"]
        beat_det += beats["detected"]
    precision = beat_hits / beat_det if beat_det else 0.0
    recall = beat_hits / beat_ref if beat_ref else 0.0
    f_measure = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "recordings": len(results),
        "scored_duration_seconds": round(duration, 6),
        "macro_lead_exact_accuracy": macro([item["metrics"]["lead_sheet"]["exact_accuracy"] for item in results]),
        "duration_weighted_lead_exact_accuracy": round(exact / duration, 6) if duration else None,
        "macro_enharmonic_shorthand_accuracy": macro([item["metrics"]["lead_sheet"].get("enharmonic_shorthand_accuracy") for item in results]),
        "duration_weighted_enharmonic_shorthand_accuracy": round(
            sum((item["metrics"]["lead_sheet"].get("enharmonic_shorthand_accuracy") or 0.0) * item["annotation"]["scored_duration_seconds"] for item in results) / duration,
            6,
        ) if duration else None,
        "same_root_major_minor_swap_seconds": round(
            sum(item["metrics"]["lead_sheet"]["disagreement_seconds"].get("major_minor", 0.0) for item in results),
            6,
        ),
        "macro_lead_root_accuracy": macro([item["metrics"]["lead_sheet"]["root_accuracy"] for item in results]),
        "duration_weighted_lead_root_accuracy": round(root / duration, 6) if duration else None,
        "macro_lead_major_minor_accuracy": macro([item["metrics"]["lead_sheet"]["major_minor_accuracy"] for item in results]),
        "duration_weighted_lead_major_minor_accuracy": round(major_hit_seconds / major_ref_seconds, 6) if major_ref_seconds else None,
        "macro_performed_exact_accuracy": macro([item["metrics"]["performed_voicing"]["exact_accuracy"] for item in results]),
        "macro_beat_f_measure": macro([item["metrics"]["beats"]["f_measure"] for item in results]),
        "micro_beat_precision": round(precision, 6),
        "micro_beat_recall": round(recall, 6),
        "micro_beat_f_measure": round(f_measure, 6),
        "macro_beat_mean_abs_seconds": macro([item["metrics"]["beats"]["mean_abs_seconds"] for item in results]),
        "macro_bpm_error": macro([item["metrics"]["bpm_error"] for item in results]),
        "macro_boundary_mean_abs_seconds": macro([item["metrics"]["lead_sheet_boundaries"]["mean_abs_seconds"] for item in results]),
    }


def beat_phase(reference, detected, bpm) -> dict:
    if not reference or not detected or not bpm:
        return {}
    offsets = []
    for instant in reference:
        nearest = min(detected, key=lambda value: abs(value - instant))
        offsets.append(nearest - instant)
    half = 60.0 / float(bpm) / 2.0
    signed = sorted(offsets)
    absolute = sorted(abs(value) for value in offsets)
    count = len(offsets)
    return {
        "median_nearest_detection_minus_reference_seconds": round(signed[count // 2], 6),
        "median_abs_seconds": round(absolute[count // 2], 6),
        "fraction_within_70ms": round(sum(abs(value) <= BEAT_WINDOW_SECONDS for value in offsets) / count, 6),
        "half_beat_seconds": round(half, 6),
        "fraction_near_half_beat": round(sum(abs(abs(value) - half) <= BEAT_WINDOW_SECONDS for value in offsets) / count, 6),
        "note": "Diagnostic only. The reported F-measure stays on the 70 ms window and is not retuned to this offset.",
    }


def enrich_recording(item: dict) -> None:
    jams = load_jams(find_one(f"{item['id']}.jams"))
    reference = beat_reference(jams)
    scored = float(item["annotation"]["scored_duration_seconds"])
    detected = [float(value) for value in (item["beats"].get("beats") or [])]
    reference_beats = [instant for instant in reference["beats"] if instant <= scored + 1e-6]
    item["metrics"]["beat_phase"] = beat_phase(reference_beats, detected, item["metrics"].get("bpm_annotation"))
    slices = time_slices(item["annotation"]["lead_sheet"], predicted_segments(item["chords"]), scored)
    item["metrics"]["lead_sheet"]["disagreement_seconds"] = {
        key: round(value, 6) for key, value in slices["totals"].items()
    }
    item["metrics"]["lead_sheet"]["enharmonic_shorthand_accuracy"] = (
        round((slices["totals"]["exact"] + slices["totals"]["enharmonic"]) / scored, 6) if scored else None
    )


def synthetic_comparison() -> dict:
    if not PRIOR_EVIDENCE_PATH.is_file():
        return {"available": False}
    prior = json.loads(PRIOR_EVIDENCE_PATH.read_text(encoding="utf-8"))
    warm = prior["runs"]["reference_warm"]
    long_wav = prior["runs"]["long_wav"]
    return {
        "available": True,
        "source": "python_backend/research/backend_04h_benchmark_evidence.json",
        "synthetic_12s_warm_beat_seconds": warm["beat_wall_seconds"],
        "synthetic_12s_warm_chord_seconds": warm["chord_wall_seconds"],
        "synthetic_12s_warm_combined_rtf": warm["real_time_factor"]["combined"],
        "synthetic_96s_wav_beat_seconds": long_wav["beat_wall_seconds"],
        "synthetic_96s_wav_chord_seconds": long_wav["chord_wall_seconds"],
        "synthetic_96s_wav_combined_rtf": long_wav["real_time_factor"]["combined"],
        "synthetic_peak_memory_mb": prior["peak_memory_mb"],
        "note": "04H used generated tones. These GuitarSet figures are a different signal. Linear scaling is not assumed.",
    }


def free_port() -> int:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    return port


def post_multipart(port: int, secret: str, route: str, audio: Path, fields: dict) -> dict:
    boundary = "----chordmini04i"
    payload = []
    for key, value in fields.items():
        payload.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
        )
    payload.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{audio.name}\"\r\nContent-Type: audio/wav\r\n\r\n".encode()
    )
    payload.append(audio.read_bytes())
    payload.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(payload)
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=300)
    started = time.perf_counter()
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
    }
    if secret:
        headers["X-ChordMini-Inference-Token"] = secret
    connection.request("POST", route, body=body, headers=headers)
    response = connection.getresponse()
    raw = response.read()
    elapsed = time.perf_counter() - started
    connection.close()
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        parsed = {"raw_prefix": raw[:200].decode("utf-8", errors="replace")}
    parsed_text = json.dumps(parsed)
    if secret and secret in parsed_text:
        raise SystemExit("Flask response contained the inference credential")
    return {"status": response.status, "seconds": round(elapsed, 4), "body": parsed}


def run_flask(results: list) -> dict:
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
                raise SystemExit(f"Flask exited before health ({child.returncode})")
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
            raise SystemExit("Flask health timed out")
        denied = post_multipart(port, "", "/api/detect-beats", Path(results[0]["audio"]["path"]), {"detector": "madmom"})
        timings = []
        for item in results:
            audio = Path(item["audio"]["path"])
            if audio.stat().st_size >= TESTING_UPLOAD_CAP_BYTES:
                timings.append({
                    "id": item["id"],
                    "accepted": False,
                    "reason": "file meets the 5 MB testing upload cap; the cap was not raised",
                })
                continue
            beats = post_multipart(port, secret, "/api/detect-beats", audio, {"detector": "madmom"})
            chords = post_multipart(
                port, secret, "/api/recognize-chords", audio,
                {"detector": "chord-cnn-lstm", "model": "chord-cnn-lstm", "chord_dict": "submission"},
            )
            timings.append({
                "id": item["id"],
                "accepted": beats["status"] == 200 and chords["status"] == 200,
                "beat_status": beats["status"],
                "chord_status": chords["status"],
                "beat_seconds": beats["seconds"],
                "chord_seconds": chords["seconds"],
                "beat_model": beats["body"].get("model_used"),
                "chord_model": chords["body"].get("model_used"),
                "beat_success": beats["body"].get("success"),
                "chord_success": chords["body"].get("success"),
                "bpm": beats["body"].get("bpm"),
                "chord_count": len(chords["body"].get("chords") or []),
            })
        status_path = Path(f"/proc/{child.pid}/status")
        hwm = None
        if status_path.is_file():
            for line in status_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("VmHWM:"):
                    hwm = int(line.split()[1])
        return {
            "listener": "127.0.0.1",
            "firebase_identity": "NOT_USED_ON_THIS_DIRECT_FLASK_PATH",
            "tokenless_status": denied["status"],
            "recordings": timings,
            "flask_vm_hwm_kb": hwm,
            "flask_vm_hwm_mb": None if hwm is None else round(hwm / 1024.0, 2),
            "note": "Direct protected Flask on loopback. The Next.js gateway measurement is separate and uses a mocked identity.",
        }
    finally:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()


def main() -> int:
    os.environ.setdefault("TESTING", "1")
    if not ANNOTATION_ZIP.is_file():
        raise SystemExit("annotation.zip is not present; refusing to evaluate without the official archive")
    if md5(ANNOTATION_ZIP) != ANNOTATION_MD5 or sha256(ANNOTATION_ZIP) != ANNOTATION_SHA256:
        raise SystemExit("annotation.zip checksum does not match the Zenodo record")
    audio_zip = CORPUS / "audio_mono-mic.zip"
    audio_zip_md5 = md5(audio_zip) if audio_zip.is_file() else None
    vocabulary = load_submission_labels()
    init_started = time.perf_counter()
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    services = (BeatDetectionService(), ChordRecognitionService())
    init_seconds = round(time.perf_counter() - init_started, 4)
    cold_started = time.perf_counter()
    first = analyze_file(services, SELECTED[0], vocabulary)
    cold_seconds = round(time.perf_counter() - cold_started, 4)
    warm_first = analyze_file(services, SELECTED[0], vocabulary)
    rest = [analyze_file(services, record, vocabulary) for record in SELECTED[1:]]
    results = [first, *rest]
    for item in results:
        enrich_recording(item)
    same_labels = [row.get("chord") for row in (first["chords"].get("chords") or [])] == [
        row.get("chord") for row in (warm_first["chords"].get("chords") or [])
    ]
    try:
        flask = run_flask(results)
    except (OSError, SystemExit, http.client.HTTPException) as exc:
        flask = {"error": str(exc), "listener": "127.0.0.1"}
    evidence = {
        "phase": "BACKEND-04I",
        "real_music_accuracy_status": "MEASURED",
        "dataset": {
            "name": "GuitarSet",
            "version": "1.1.0",
            "doi": "10.5281/zenodo.3371780",
            "record_url": "https://zenodo.org/records/3371780",
            "published": "2019-08-20",
            "authors": [
                "Qingyang Xi",
                "Rachel M. Bittner",
                "Johan Pauwels",
                "Xuzhou Ye",
                "Juan P. Bello",
            ],
            "citation": "Q. Xi, R. Bittner, J. Pauwels, X. Ye, and J. P. Bello, \"GuitarSet: A Dataset for Guitar Transcription,\" ISMIR 2018.",
            "license": "Creative Commons Attribution 4.0 International",
            "license_source": "Zenodo record 3371780 license field, read before download.",
            "archives": {
                "annotation.zip": {
                    "md5": ANNOTATION_MD5,
                    "sha256": ANNOTATION_SHA256,
                    "verified": True,
                },
                "audio_mono-mic.zip": {
                    "md5_published": AUDIO_ZIP_MD5,
                    "md5_local": audio_zip_md5,
                    "verified": audio_zip_md5 == AUDIO_ZIP_MD5,
                },
            },
            "audio_representation": "Official mono-microphone WAV named {id}_mic.wav inside audio_mono-mic.zip. No resampling and no downmix in this script.",
            "redistributed_in_git": False,
            "errata_excluded": [
                "04_BN3-154-E_comp timing offset reported in marl/GuitarSet issue 5",
                "04_Jazz1-200-B_comp timing offset reported in marl/GuitarSet issue 5",
                "02_Funk2-119-G_comp duplicated note reported in marl/GuitarSet issue 4",
            ],
            "annotation_limitations": (
                "Zenodo states that the hexaphonic pickup largely automates annotation. "
                "The version 0.9 chord layer is labeled semi-automatic with manual verification, "
                "and its segmentation and root come from sheet music. The other chord layer is the "
                "lead-sheet symbol on those same boundaries. Neither layer is treated as infallible. "
                "The tempo annotation is one constant value per excerpt."
            ),
        },
        "normalization": {
            "primary_chord_reference": "lead_sheet chord layer in the official JAMS (the layer that is not version 0.9)",
            "secondary_chord_reference": "performed_voicing chord layer, annotation version 0.9",
            "exact": "Unicode-stripped raw Harte string equality. No enharmonic rewrite, no bass deletion, no extension folding.",
            "root": "Pitch-class equality of the Harte root. Enharmonic spellings match. N matches neither a chord root nor a different no-chord label.",
            "major_minor": "Shorthand exactly maj/major or min/minor. Sevenths, half-diminished chords, suspensions, and parenthetical alterations stay outside this score. The denominator is lead-sheet time whose shorthand is a major or minor triad.",
            "boundary": "A reference segment is paired only when a prediction shares its root pitch class and overlaps at least half of the reference segment.",
            "beats": "One-to-one greedy match inside 70 ms. Inter-beat gaps in this sample are wider than 140 ms, so the windows do not overlap. This is not the mir_eval package.",
            "submission_vocabulary": "Qualities listed in submission_chord_list.txt, transposed from C. Coverage is reported and is not used to drop mismatches from the exact score.",
            "aggregates": "Macro is the unweighted mean of per-recording scores. Duration-weighted chord scores sum time. Micro beat scores pool counts.",
        },
        "selection_rule": (
            "Player index 00, comp version, progression 2, lower filename BPM of that progression. "
            "One excerpt from each style code BN, Funk, Jazz, Rock, and SS. "
            "Pinned before inference."
        ),
        "selected_ids": [record["id"] for record in SELECTED],
        "cpu": cpu_info(),
        "model_init_seconds": init_seconds,
        "cold_first_pass_seconds": cold_seconds,
        "warm_repeat_of_first": {
            "id": warm_first["id"],
            "beat_wall_seconds": warm_first["beat_wall_seconds"],
            "chord_wall_seconds": warm_first["chord_wall_seconds"],
            "combined_wall_seconds": warm_first["combined_wall_seconds"],
            "real_time_factor": warm_first["real_time_factor"],
            "chord_labels_match_cold": same_labels,
        },
        "recordings": results,
        "aggregate": aggregate(results),
        "flask_loopback": flask,
        "synthetic_comparison": synthetic_comparison(),
        "peak_memory_mb": round(peak_mb(), 2),
        "model_changes": False,
        "firebase_identity": "NOT_USED_IN_PROCESS_OR_DIRECT_FLASK",
    }
    failures = []
    if audio_zip_md5 != AUDIO_ZIP_MD5:
        failures.append("audio zip checksum")
    for item in results:
        if not item["beats"].get("success") or item["beats"].get("model_used") != "madmom":
            failures.append(f"{item['id']} beats")
        if not item["chords"].get("success") or item["chords"].get("model_used") != "chord-cnn-lstm":
            failures.append(f"{item['id']} chords")
        if item["chords"].get("chord_dict") not in (None, "submission"):
            failures.append(f"{item['id']} chord_dict")
        if item["audio"]["peak_abs"] <= 0:
            failures.append(f"{item['id']} silent")
    if flask.get("tokenless_status") != 401:
        failures.append("tokenless flask")
    evidence["failures"] = failures
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"evidence={EVIDENCE_PATH}")
    print(f"init_s={init_seconds} cold_s={cold_seconds} peak_mb={evidence['peak_memory_mb']}")
    for item in results:
        metrics = item["metrics"]
        print(
            f"{item['id']} dur={item['annotation']['scored_duration_seconds']} "
            f"beat_s={item['beat_wall_seconds']} chord_s={item['chord_wall_seconds']} "
            f"rtf={item['real_time_factor']['combined']} "
            f"beat_f={metrics['beats']['f_measure']} bpm_error={metrics['bpm_error']} "
            f"exact={metrics['lead_sheet']['exact_accuracy']} root={metrics['lead_sheet']['root_accuracy']} "
            f"majmin={metrics['lead_sheet']['major_minor_accuracy']} "
            f"boundary={metrics['lead_sheet_boundaries']['mean_abs_seconds']}"
        )
    print(f"aggregate={evidence['aggregate']}")
    if failures:
        print("failures=" + ",".join(failures))
        return 1
    print("evaluation=PASS")
    return 0


def attach_gateway(path: Path) -> int:
    evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
    gateway = json.loads(path.read_text(encoding="utf-8"))
    hwm_kb = gateway.get("flaskVmHwmKb")
    evidence["next_gateway"] = {
        "source": (
            "Jest mocked-identity localhost gateway. verifyIdToken is mocked. "
            "This is not production Firebase authentication. Flask was already warm."
        ),
        "firebase_identity": gateway.get("firebaseIdentity"),
        "timings": gateway.get("timings"),
        "flask_vm_hwm_kb": hwm_kb,
        "flask_vm_hwm_mb": None if not hwm_kb else round(hwm_kb / 1024.0, 2),
        "vm_hwm_note": "This peak is for the Flask process after the earlier synthetic requests in the same Jest file.",
        "real_music_accuracy": gateway.get("realMusicAccuracy"),
    }
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"gateway_attached={EVIDENCE_PATH}")
    return 0


def annotate_existing() -> int:
    evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
    for item in evidence["recordings"]:
        enrich_recording(item)
    evidence["aggregate"] = aggregate(evidence["recordings"])
    evidence["normalization"]["enharmonic_shorthand"] = (
        "Secondary score. Root pitch class, shorthand, and bass agree. "
        "Flat and sharp spellings match. Extensions are not folded into triads. "
        "The primary exact score remains raw string equality."
    )
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"annotated={EVIDENCE_PATH}")
    print(evidence["aggregate"])
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--annotate-existing":
        raise SystemExit(annotate_existing())
    if len(sys.argv) == 3 and sys.argv[1] == "--attach-gateway":
        raise SystemExit(attach_gateway(Path(sys.argv[2])))
    raise SystemExit(main())
