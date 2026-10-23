"""BACKEND-04H CPU benchmark on a longer synthetic fixture.

The audio is generated in this process from the same oscillator and click
recipe as the 12-second reference. It is not a recorded performance and it
has no independent annotation. Agreement with the generator is reported as
synthetic agreement only. Real-music accuracy stays BLOCKED.

This script does not bind a socket, does not raise the upload cap, and does
not print a credential.
"""

import importlib.util
import json
import os
import platform
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DIR = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

EVIDENCE_PATH = RESEARCH_DIR / "backend_04h_benchmark_evidence.json"
PRIOR_EVIDENCE_PATH = RESEARCH_DIR / "backend_04g_decode_evidence.json"
OUT_DIR = Path("/tmp/chordmini-04h")
REFERENCE_SHA256 = "9f28c07ea70690c82a1b7b4b883ab0624489020950e782210dbddaeab1b73914"
REFERENCE_SECONDS = 12.0
LONG_SECONDS = 96.0
REGION_SECONDS = 4.0
CLICK_SECONDS = 0.5
GROUND_BPM = 120.0
BEAT_WINDOW_SECONDS = 0.07
TESTING_UPLOAD_CAP_BYTES = 5 * 1024 * 1024
CHORD_CYCLE = (
    ("C:maj", (261.63, 329.63, 392.00)),
    ("F:maj", (349.23, 440.00, 523.25)),
    ("G:maj", (392.00, 493.88, 587.33)),
)
REFERENCE_REGIONS = (
    {"start": 0.0, "end": 4.0, "chord": "C:maj"},
    {"start": 4.0, "end": 8.0, "chord": "F:maj"},
    {"start": 8.0, "end": 12.0, "chord": "G:maj"},
)
FABRICATED = [
    {"start": 0.0, "end": 2.0, "chord": "C:maj"},
    {"start": 2.0, "end": 4.0, "chord": "F:maj"},
    {"start": 4.0, "end": 6.0, "chord": "G:maj"},
    {"start": 6.0, "end": 8.0, "chord": "C:maj"},
]
EVALUATION_LABEL = "synthetic_generator_agreement"
VOCABULARY = (
    "Exact Chord-CNN-LSTM submission strings. The generator uses C:maj, F:maj, "
    "and G:maj. N is the model's no-chord label. No enharmonic folding, no "
    "inversion folding, and no major/minor equivalence. A slice counts as "
    "correct only when the strings are equal."
)


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, RESEARCH_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def pcm_bytes(seconds: float, sample_rate: int) -> int:
    return int(sample_rate * seconds) * 2 + 44


def click_times(duration: float) -> list:
    count = int(duration / CLICK_SECONDS)
    return [index * CLICK_SECONDS for index in range(count)]


def long_regions() -> list:
    count = int(LONG_SECONDS / REGION_SECONDS)
    regions = []
    for index in range(count):
        label, frequencies = CHORD_CYCLE[index % len(CHORD_CYCLE)]
        start = index * REGION_SECONDS
        regions.append({
            "start": start,
            "end": start + REGION_SECONDS,
            "chord": label,
            "frequencies_hz": list(frequencies),
        })
    return regions


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


def ffmpeg_version() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return "missing"
    completed = subprocess.run(
        [ffmpeg, "-version"],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.splitlines()[0]


def mean(values) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def label_at(segments, instant: float, duration: float) -> str:
    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        if start <= instant < end:
            return str(segment.get("chord") or "N")
        if instant == duration and start < instant <= end:
            return str(segment.get("chord") or "N")
    return "N"


def parse_chord(label: str) -> dict:
    if label in (None, "N", "X"):
        return {"kind": "none", "root": None, "quality": None, "bass": None}
    base, separator, bass = str(label).partition("/")
    root, quality_separator, quality = base.partition(":")
    return {
        "kind": "chord",
        "root": root,
        "quality": quality if quality_separator else "",
        "bass": bass if separator else None,
    }


def disagreement_kind(expected: str, predicted: str) -> str:
    if expected == predicted:
        return "match"
    left = parse_chord(expected)
    right = parse_chord(predicted)
    if left["kind"] == "none" or right["kind"] == "none":
        return "no_chord"
    if left["root"] != right["root"]:
        return "root"
    if left["quality"] == right["quality"] and left["bass"] != right["bass"]:
        return "inversion"
    major = {"", "maj", "major"}
    minor = {"min", "minor"}
    pair = {left["quality"], right["quality"]}
    if pair <= major | minor and pair & major and pair & minor:
        return "major_minor"
    return "extension_or_quality"


def synthetic_quality(beats: dict, chords: dict, regions: list, clicks: list, duration: float) -> dict:
    detected = [float(value) for value in (beats.get("beats") or [])]
    used = set()
    matched_errors = []
    for click in clicks:
        best_index = None
        best_error = None
        for index, beat in enumerate(detected):
            if index in used:
                continue
            error = abs(beat - click)
            if error <= BEAT_WINDOW_SECONDS and (best_error is None or error < best_error):
                best_index = index
                best_error = error
        if best_index is not None:
            used.add(best_index)
            matched_errors.append(best_error)
    hits = len(matched_errors)
    precision = hits / len(detected) if detected else 0.0
    recall = hits / len(clicks) if clicks else 0.0
    f_measure = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    rows = [
        {
            "start": float(row.get("start", 0.0)),
            "end": float(row.get("end", 0.0)),
            "chord": str(row.get("chord") or "N"),
        }
        for row in (chords.get("chords") or [])
    ]
    boundaries = {0.0, float(duration)}
    for segment in list(regions) + rows:
        boundaries.add(min(float(duration), max(0.0, float(segment["start"]))))
        boundaries.add(min(float(duration), max(0.0, float(segment["end"]))))
    points = sorted(boundaries)
    totals = {
        "match": 0.0,
        "no_chord": 0.0,
        "root": 0.0,
        "inversion": 0.0,
        "major_minor": 0.0,
        "extension_or_quality": 0.0,
    }
    for start, end in zip(points, points[1:]):
        if end <= start:
            continue
        kind = disagreement_kind(
            label_at(regions, (start + end) / 2.0, duration),
            label_at(rows, (start + end) / 2.0, duration),
        )
        totals[kind] += end - start
    paired = []
    unmatched = 0
    for expected in regions:
        best = None
        best_overlap = 0.0
        for predicted in rows:
            if predicted["chord"] != expected["chord"]:
                continue
            overlap = min(expected["end"], predicted["end"]) - max(expected["start"], predicted["start"])
            if overlap > best_overlap:
                best = predicted
                best_overlap = overlap
        if best is None:
            unmatched += 1
            continue
        paired.append({
            "chord": expected["chord"],
            "start_delta_seconds": round(best["start"] - expected["start"], 6),
            "end_delta_seconds": round(best["end"] - expected["end"], 6),
            "overlap_seconds": round(best_overlap, 6),
        })
    boundary_abs = []
    for item in paired:
        boundary_abs.append(abs(item["start_delta_seconds"]))
        boundary_abs.append(abs(item["end_delta_seconds"]))
    bpm = beats.get("bpm")
    confidences = sorted(str(row.get("confidence")) for row in (chords.get("chords") or []))
    confidences = list(dict.fromkeys(confidences))
    return {
        "evaluation": EVALUATION_LABEL,
        "real_music_accuracy": "BLOCKED",
        "vocabulary": VOCABULARY,
        "beat_window_seconds": BEAT_WINDOW_SECONDS,
        "beat_metric": (
            "One-to-one greedy match inside a 70 ms window. Click spacing is "
            "500 ms, so the windows do not overlap. This is not the mir_eval package."
        ),
        "tempo_change_sensitivity": "NOT_MEASURED",
        "tempo_change_reason": "The click interval is constant. No tempo change was synthesized.",
        "reference_clicks": len(clicks),
        "detected_beats": len(detected),
        "matched_beats": hits,
        "beat_precision": round(precision, 6),
        "beat_recall": round(recall, 6),
        "beat_f_measure": round(f_measure, 6),
        "beat_mean_abs_seconds": mean(matched_errors),
        "beat_max_abs_seconds": None if not matched_errors else round(max(matched_errors), 6),
        "bpm": bpm,
        "bpm_error": None if bpm is None else round(abs(float(bpm) - GROUND_BPM), 6),
        "time_weighted_chord_accuracy": round(totals["match"] / duration, 6) if duration else None,
        "chord_disagreement_seconds": {key: round(value, 6) for key, value in totals.items()},
        "chord_regions": len(regions),
        "unmatched_chord_regions": unmatched,
        "mean_abs_boundary_seconds": mean(boundary_abs),
        "mean_abs_start_seconds": mean([abs(item["start_delta_seconds"]) for item in paired]),
        "mean_abs_end_seconds": mean([abs(item["end_delta_seconds"]) for item in paired]),
        "confidence_values": confidences,
        "confidence_note": "confidence 1.0 is the lab parser placeholder, not a measured model score.",
        "boundary_pairs": paired,
    }


def write_long_wav(path: Path, runner, regions: list) -> None:
    import wave

    import numpy

    sample_rate = runner.SAMPLE_RATE
    mix = numpy.zeros(int(sample_rate * LONG_SECONDS), dtype=numpy.float64)
    for region in regions:
        start_index = int(sample_rate * region["start"])
        chord = sum(runner.tone(frequency, REGION_SECONDS) for frequency in region["frequencies_hz"])
        mix[start_index:start_index + chord.size] += chord
    click = numpy.hanning(int(sample_rate * 0.02))
    for beat_time in click_times(LONG_SECONDS):
        index = int(sample_rate * beat_time)
        mix[index:index + click.size] += click * 1.5
    peak = numpy.max(numpy.abs(mix))
    if peak <= 0:
        raise SystemExit("synthetic mix is silent")
    pcm = numpy.clip(mix / peak * 0.8, -1.0, 1.0)
    frames = (pcm * 32767.0).astype(numpy.int16).tobytes()
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(frames)


def write_benchmark_fixtures() -> dict:
    """Generate the 12-second reference and the longer synthetic WAV and MP3.

    Audio stays under /tmp. The 5 MB testing upload cap is not raised.
    """
    prior = load_module("backend_04g_decode_inference", "backend_04g_decode_inference.py")
    runner = prior.load_runner()
    if runner.SAMPLE_RATE != 22050:
        raise SystemExit("reference generator sample rate changed")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    reference_path = OUT_DIR / "reference-12s.wav"
    long_wav_path = OUT_DIR / "synthetic-96s.wav"
    long_mp3_path = OUT_DIR / "synthetic-96s.mp3"
    reference = runner.write_fixture(reference_path)
    if reference["sha256"] != REFERENCE_SHA256:
        raise SystemExit("12-second reference SHA-256 changed; the generator must stay frozen")
    regions = long_regions()
    write_long_wav(long_wav_path, runner, regions)
    if long_wav_path.stat().st_size >= TESTING_UPLOAD_CAP_BYTES:
        raise SystemExit("longer WAV meets the testing upload cap; refusing to raise it")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is not installed")
    subprocess.run(
        [
            ffmpeg, "-y", "-i", str(long_wav_path),
            "-codec:a", "libmp3lame", "-b:a", "128k",
            "-write_xing", "1",
            str(long_mp3_path),
        ],
        check=True,
        capture_output=True,
    )
    long_mp3_path.write_bytes(prior.strip_leading_id3(long_mp3_path.read_bytes()))
    fixtures = {}
    for name, path, provenance in (
        (
            "reference_wav",
            reference_path,
            "Existing 12-second synthetic WAV from run_minimum_inference.write_fixture. No external recording.",
        ),
        (
            "long_wav",
            long_wav_path,
            "Synthetic 96-second PCM generated in backend_04h_benchmark.py. Four-second C:maj/F:maj/G:maj cycle and a click every 0.5 seconds. Not a performance.",
        ),
        (
            "long_mp3",
            long_mp3_path,
            "LAME MPEG Layer III encoded from the 96-second synthetic WAV with ffmpeg libmp3lame 128k. Encoder ID3 was removed. Not a performance.",
        ),
    ):
        decoded = prior.decoded_energy(path)
        fixtures[name] = {
            "path": str(path),
            "bytes": path.stat().st_size,
            "sha256": prior.sha256(path),
            "provenance": provenance,
            "license": "Original synthetic signal. No third-party recording.",
            "real_performance": False,
            "independent_ground_truth": False,
            **prior.probe(path),
            **decoded,
        }
    fixtures["reference_wav"]["duration_seconds_generated"] = REFERENCE_SECONDS
    fixtures["long_wav"]["duration_seconds_generated"] = LONG_SECONDS
    fixtures["long_mp3"]["duration_seconds_generated"] = LONG_SECONDS
    fixtures["long_wav"]["sample_rate_generated"] = runner.SAMPLE_RATE
    fixtures["long_wav"]["channels_generated"] = 1
    fixtures["long_wav"]["regions"] = regions
    return fixtures


def slim(result: dict) -> dict:
    keep = (
        "success", "beats", "downbeats", "bpm", "time_signature", "model_used",
        "model_name", "chords", "total_chords", "duration", "chord_dict",
        "processing_time", "error",
    )
    return {key: result.get(key) for key in keep if key in result}


def fabricated(chords: dict) -> bool:
    rows = [
        {"start": row.get("start"), "end": row.get("end"), "chord": row.get("chord")}
        for row in (chords.get("chords") or [])
    ]
    return rows == FABRICATED


def analyze(services, path: Path, regions: list, clicks: list, duration: float) -> dict:
    beats_service, chord_service = services
    started = time.perf_counter()
    beats = beats_service.detect_beats(str(path), detector="madmom", force=False)
    beat_seconds = time.perf_counter() - started
    started = time.perf_counter()
    chords = chord_service.recognize_chords(
        str(path),
        detector="chord-cnn-lstm",
        chord_dict="submission",
        force=False,
        use_spleeter=False,
    )
    chord_seconds = time.perf_counter() - started
    combined = beat_seconds + chord_seconds
    return {
        "beat_wall_seconds": round(beat_seconds, 4),
        "chord_wall_seconds": round(chord_seconds, 4),
        "combined_wall_seconds": round(combined, 4),
        "real_time_factor": {
            "beat": round(beat_seconds / duration, 4),
            "chord": round(chord_seconds / duration, 4),
            "combined": round(combined / duration, 4),
        },
        "beats": slim(beats),
        "chords": slim(chords),
        "synthetic_quality": synthetic_quality(beats, chords, regions, clicks, duration),
        "fabricated_pattern_returned": fabricated(chords),
        "peak_memory_mb": round(peak_mb(), 2),
    }


def max_abs_delta(left, right) -> float | None:
    if len(left) != len(right) or not left:
        return None
    return round(max(abs(float(a) - float(b)) for a, b in zip(left, right)), 6)


def compare_runs(left: dict, right: dict) -> dict:
    left_chords = left["chords"].get("chords") or []
    right_chords = right["chords"].get("chords") or []
    start_deltas = [
        round(float(b.get("start", 0)) - float(a.get("start", 0)), 6)
        for a, b in zip(left_chords, right_chords)
    ]
    return {
        "beat_count_left": len(left["beats"].get("beats") or []),
        "beat_count_right": len(right["beats"].get("beats") or []),
        "beat_max_abs_seconds": max_abs_delta(left["beats"].get("beats") or [], right["beats"].get("beats") or []),
        "bpm_left": left["beats"].get("bpm"),
        "bpm_right": right["beats"].get("bpm"),
        "chord_count_left": len(left_chords),
        "chord_count_right": len(right_chords),
        "chord_labels_equal": [a.get("chord") for a in left_chords] == [b.get("chord") for b in right_chords],
        "chord_start_max_abs_seconds": None if not start_deltas or len(left_chords) != len(right_chords) else round(max(abs(value) for value in start_deltas), 6),
    }


def reference_agreement(reference_run: dict) -> dict:
    if not PRIOR_EVIDENCE_PATH.is_file():
        return {"available": False}
    prior = json.loads(PRIOR_EVIDENCE_PATH.read_text(encoding="utf-8"))
    previous = prior["results"]["wav"]
    beat_delta = max_abs_delta(
        reference_run["beats"].get("beats") or [],
        previous["beats"].get("beats") or [],
    )
    labels_now = [row.get("chord") for row in (reference_run["chords"].get("chords") or [])]
    labels_then = [row.get("chord") for row in (previous["chords"].get("chords") or [])]
    return {
        "available": True,
        "source": "python_backend/research/backend_04g_decode_evidence.json results.wav",
        "beat_max_abs_seconds": beat_delta,
        "chord_labels_equal": labels_now == labels_then,
        "note": "Reproduction of the frozen 12-second synthetic result. Not real-music accuracy.",
    }


def main() -> int:
    os.environ.setdefault("TESTING", "1")
    lab = BACKEND_ROOT / "models" / "Chord-CNN-LSTM" / "data" / "chord_placeholder.lab"
    fixtures = write_benchmark_fixtures()
    from security.inference_guard import sniff_audio

    sniff = {
        "reference_wav": sniff_audio(fixtures["reference_wav"]["path"]),
        "long_wav": sniff_audio(fixtures["long_wav"]["path"]),
        "long_mp3": sniff_audio(fixtures["long_mp3"]["path"]),
    }
    init_started = time.perf_counter()
    from services.audio.beat_detection_service import BeatDetectionService
    from services.audio.chord_recognition_service import ChordRecognitionService

    services = (BeatDetectionService(), ChordRecognitionService())
    init_seconds = round(time.perf_counter() - init_started, 4)
    reference_clicks = click_times(REFERENCE_SECONDS)
    long_clicks = click_times(LONG_SECONDS)
    regions = fixtures["long_wav"]["regions"]
    cold_started = time.perf_counter()
    reference_cold = analyze(
        services,
        Path(fixtures["reference_wav"]["path"]),
        list(REFERENCE_REGIONS),
        reference_clicks,
        REFERENCE_SECONDS,
    )
    cold_total = round(time.perf_counter() - cold_started, 4)
    reference_warm = analyze(
        services,
        Path(fixtures["reference_wav"]["path"]),
        list(REFERENCE_REGIONS),
        reference_clicks,
        REFERENCE_SECONDS,
    )
    long_wav = analyze(
        services,
        Path(fixtures["long_wav"]["path"]),
        regions,
        long_clicks,
        LONG_SECONDS,
    )
    long_mp3 = analyze(
        services,
        Path(fixtures["long_mp3"]["path"]),
        regions,
        long_clicks,
        LONG_SECONDS,
    )
    import importlib.metadata as importlib_metadata

    installed = {}
    for name in ("torch", "numpy", "librosa", "soundfile", "madmom"):
        try:
            installed[name] = importlib_metadata.version(name)
        except importlib_metadata.PackageNotFoundError:
            installed[name] = None
    evidence = {
        "phase": "BACKEND-04H",
        "firebase_identity": "NOT_USED_IN_THIS_PROCESS",
        "listener": "none",
        "real_music_accuracy_status": "BLOCKED",
        "dataset": {
            "recording_source": "Generated locally by backend_04h_benchmark.py and run_minimum_inference.write_fixture.",
            "artist": None,
            "license_status": (
                "Original synthetic signal created for this local research run. "
                "No scraped audio and no external download. Not a musical performance."
            ),
            "real_performance_audio": False,
            "independent_ground_truth": False,
            "ground_truth": "Synthesizer schedule. Chord labels and click times were produced by this script, not by an independent annotator.",
            "repository_search": {
                "tracked_performance_recording": False,
                "chord_placeholder_lab_bytes": lab.stat().st_size if lab.is_file() else None,
                "external_download": False,
                "note": (
                    "Tracked wav, mp3, flac, and ogg assets are absent. "
                    "chord_placeholder.lab is empty. External datasets named in third-party READMEs were not downloaded."
                ),
            },
            "duration_selection": {
                "chosen_seconds": LONG_SECONDS,
                "testing_upload_cap_bytes": TESTING_UPLOAD_CAP_BYTES,
                "pcm_bytes_at_chosen_duration": pcm_bytes(LONG_SECONDS, 22050),
                "pcm_bytes_at_120s": pcm_bytes(120.0, 22050),
                "pcm_bytes_at_180s": pcm_bytes(180.0, 22050),
                "reason": (
                    "A 120-second or 180-second 22050 Hz 16-bit mono WAV exceeds "
                    "TestingConfig DIRECT_UPLOAD_SIZE_LIMIT_MB=5. The cap was not raised."
                ),
            },
        },
        "cpu": cpu_info(),
        "ffmpeg": ffmpeg_version(),
        "installed": installed,
        "fixtures": fixtures,
        "flask_sniff": sniff,
        "model_init_seconds": init_seconds,
        "cold_reference_pass_seconds": cold_total,
        "runs": {
            "reference_cold": reference_cold,
            "reference_warm": reference_warm,
            "long_wav": long_wav,
            "long_mp3": long_mp3,
        },
        "results": {
            "long_wav": long_wav,
            "long_mp3": long_mp3,
        },
        "reference_versus_04g": reference_agreement(reference_cold),
        "wav_versus_mp3": compare_runs(long_wav, long_mp3),
        "scaling": {
            "duration_ratio_long_over_reference": round(LONG_SECONDS / REFERENCE_SECONDS, 4),
            "warm_beat_wall_ratio": round(
                long_wav["beat_wall_seconds"] / reference_warm["beat_wall_seconds"], 4
            ) if reference_warm["beat_wall_seconds"] else None,
            "warm_chord_wall_ratio": round(
                long_wav["chord_wall_seconds"] / reference_warm["chord_wall_seconds"], 4
            ) if reference_warm["chord_wall_seconds"] else None,
            "note": "Wall-time ratios are observed on this machine. Linear scaling is not assumed and is not extrapolated to a commercial song.",
        },
        "peak_memory_mb": round(peak_mb(), 2),
        "decoder_failures": [],
        "timeouts": {
            "observed_on_these_fixtures": False,
            "gateway_bound_ms_unchanged": 300000,
            "gateway_duration_cap_seconds_unchanged": 300,
        },
    }
    failures = []
    if sniff != {"reference_wav": "wav", "long_wav": "wav", "long_mp3": "mp3"}:
        failures.append(f"sniff {sniff}")
    for name in ("reference_wav", "long_wav", "long_mp3"):
        if fixtures[name]["peak_abs"] <= 0:
            failures.append(f"{name} silent")
            evidence["decoder_failures"].append(f"{name} peak_abs<=0")
    for name, item in (
        ("reference_cold", reference_cold),
        ("reference_warm", reference_warm),
        ("long_wav", long_wav),
        ("long_mp3", long_mp3),
    ):
        if not item["beats"].get("success") or item["beats"].get("model_used") != "madmom":
            failures.append(f"{name} beats")
        if not item["chords"].get("success") or item["chords"].get("model_used") != "chord-cnn-lstm":
            failures.append(f"{name} chords")
        if item["fabricated_pattern_returned"]:
            failures.append(f"{name} fabricated")
        if item["chords"].get("chord_dict") not in (None, "submission"):
            failures.append(f"{name} chord_dict")
    evidence["failures"] = failures
    # The region schedule is reproducible from this script. Keep the evidence
    # file to measurements and model output.
    evidence["fixtures"]["long_wav"].pop("regions", None)
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"evidence={EVIDENCE_PATH}")
    print(f"sniff={sniff}")
    print(f"peak_mb={evidence['peak_memory_mb']} init_s={init_seconds} cold_s={cold_total}")
    for name, item in evidence["runs"].items():
        quality = item["synthetic_quality"]
        print(
            f"{name} beat_s={item['beat_wall_seconds']} chord_s={item['chord_wall_seconds']} "
            f"rtf={item['real_time_factor']['combined']} bpm_error={quality['bpm_error']} "
            f"beat_f={quality['beat_f_measure']} chord_acc={quality['time_weighted_chord_accuracy']} "
            f"boundary={quality['mean_abs_boundary_seconds']}"
        )
    print(f"wav_versus_mp3={evidence['wav_versus_mp3']}")
    if failures:
        print("failures=" + ",".join(failures))
        return 1
    print("benchmark=PASS")
    print("real_music_accuracy=BLOCKED")
    return 0


def attach_gateway(path: Path) -> int:
    """Record an already measured mocked-identity gateway run.

    This does not rerun the models. The timings file is produced by the
    genuine-inference Jest test.
    """
    evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
    gateway = json.loads(path.read_text(encoding="utf-8"))
    hwm_kb = gateway.get("flaskVmHwmKb")
    evidence["gateway"] = {
        "source": (
            "Jest mocked-identity localhost gateway on these fixtures. "
            "verifyIdToken is mocked. This is not production Firebase authentication."
        ),
        "firebase_identity": gateway.get("firebaseIdentity"),
        "audio_duration_seconds": gateway.get("audioDurationSeconds"),
        "timings": gateway.get("timings"),
        "flask_vm_hwm_kb": hwm_kb,
        "flask_vm_hwm_mb": None if not hwm_kb else round(hwm_kb / 1024.0, 2),
        "real_music_accuracy": gateway.get("realMusicAccuracy"),
    }
    EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"gateway_attached={EVIDENCE_PATH}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--attach-gateway":
        raise SystemExit(attach_gateway(Path(sys.argv[2])))
    raise SystemExit(main())
