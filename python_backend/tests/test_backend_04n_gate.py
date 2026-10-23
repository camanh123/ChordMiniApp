"""Contract tests for the octave-tempo guard. No audio and no models."""

import hashlib
import sys
import unittest
from pathlib import Path

import numpy as np

RESEARCH = Path(__file__).resolve().parents[1] / "research"
BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(RESEARCH))

from backend_04n_gate import (  # noqa: E402
    BASELINE_MACRO_HALF_BEAT,
    LOCKED_MICRO_F_FLOOR,
    dbn_interval_bounds,
    development_gate,
    dominant_autocorrelation_bpm,
    locked_regressed,
    locked_run_allowed,
    median_interval_bpm,
    treatment_max_bpm,
    trigger_decision,
)


def beat_row(recording_id, style, precision, matched, reference, detected, half):
    return {
        "id": recording_id,
        "style_code": style,
        "half_beat_fraction": half,
        "official": {
            "precision": precision,
            "matched": matched,
            "reference": reference,
            "detected": detected,
        },
    }


def passing_rows():
    control = [
        beat_row("triggered", "Funk", 0.50, 32, 32, 64, BASELINE_MACRO_HALF_BEAT),
        beat_row("held", "Rock", 0.90, 90, 100, 100, BASELINE_MACRO_HALF_BEAT),
    ]
    treatment = [
        beat_row("triggered", "Funk", 0.70, 32, 32, 40, BASELINE_MACRO_HALF_BEAT),
        beat_row("held", "Rock", 0.90, 90, 100, 100, BASELINE_MACRO_HALF_BEAT),
    ]
    return control, treatment


class AutocorrelationTest(unittest.TestCase):
    def test_periodic_activation_selects_its_lag(self):
        activation = np.zeros(1200)
        activation[::62] = 1.0
        result = dominant_autocorrelation_bpm(activation)
        self.assertTrue(result["valid"])
        self.assertEqual(result["lag_frames"], 62)
        self.assertAlmostEqual(result["bpm"], 6000.0 / 62.0)

    def test_trigger_bounds_are_inclusive_and_do_not_move(self):
        self.assertTrue(trigger_decision(190.0, 100.0)["triggered"])
        self.assertTrue(trigger_decision(210.0, 100.0)["triggered"])
        self.assertFalse(trigger_decision(189.999, 100.0)["triggered"])
        self.assertFalse(trigger_decision(210.001, 100.0)["triggered"])
        self.assertFalse(trigger_decision(100.0, 100.0)["triggered"])
        self.assertFalse(trigger_decision(100.0, float("nan"))["triggered"])
        self.assertFalse(trigger_decision(110.0, 54.0)["triggered"])
        self.assertFalse(trigger_decision(430.0, 216.0)["triggered"])

    def test_bpm_ceiling_and_interval_guard(self):
        self.assertEqual(treatment_max_bpm(96.0), 120.0)
        self.assertEqual(treatment_max_bpm(200.0), 215.0)
        self.assertIsNotNone(dbn_interval_bounds(120.0))
        self.assertIsNone(dbn_interval_bounds(55.0))
        self.assertIsNone(dbn_interval_bounds(54.0))
        self.assertAlmostEqual(median_interval_bpm([0.0, 0.5, 1.0]), 120.0)
        self.assertEqual(median_interval_bpm([0.0]), 120.0)


class GateTest(unittest.TestCase):
    def test_all_conditions_pass(self):
        control, treatment = passing_rows()
        gate = development_gate(control, treatment, ["triggered"], True, 0.10, 700.0)
        self.assertTrue(gate["passed"], gate["reasons"])
        self.assertEqual(gate["triggered_precision_delta"], 0.20)
        self.assertEqual(gate["untriggered_micro_f_delta"], 0.0)
        self.assertTrue(locked_run_allowed({"acceptance_gate_passed": gate["passed"]}))

    def test_each_mandatory_failure_rejects(self):
        control, treatment = passing_rows()
        treatment[0]["official"]["precision"] = 0.699999
        weak = development_gate(control, treatment, ["triggered"], True, 0.10, 700.0)
        self.assertIn("triggered precision gain is below 0.20", weak["reasons"])
        self.assertFalse(weak["passed"])
        empty_control, empty_treatment = passing_rows()
        empty = development_gate(empty_control, empty_treatment, [], True, 0.10, 700.0)
        self.assertIn("no file triggered", empty["reasons"])
        self.assertFalse(locked_run_allowed({"acceptance_gate_passed": empty["passed"]}))
        moved_control, moved_treatment = passing_rows()
        moved_treatment[1]["official"] = dict(moved_treatment[1]["official"])
        moved_treatment[1]["official"]["matched"] = 80
        damaged = development_gate(moved_control, moved_treatment, ["triggered"], True, 0.10, 700.0)
        self.assertTrue(any("untriggered" in reason for reason in damaged["reasons"]))
        half_control, half_treatment = passing_rows()
        half_treatment[0]["half_beat_fraction"] = BASELINE_MACRO_HALF_BEAT + 0.01
        half_treatment[1]["half_beat_fraction"] = BASELINE_MACRO_HALF_BEAT + 0.01
        self.assertIn(
            "macro half-beat fraction is above 0.128906",
            development_gate(half_control, half_treatment, ["triggered"], True, 0.10, 700.0)["reasons"],
        )
        chord_control, chord_treatment = passing_rows()
        chord = development_gate(chord_control, chord_treatment, ["triggered"], False, 0.10, 700.0)
        self.assertIn("chord results, weights, or APIs changed", chord["reasons"])
        rtf_control, rtf_treatment = passing_rows()
        rtf = development_gate(rtf_control, rtf_treatment, ["triggered"], True, 0.21, 700.0)
        self.assertIn("warm real-time factor is above 0.20", rtf["reasons"])
        rss_control, rss_treatment = passing_rows()
        rss = development_gate(rss_control, rss_treatment, ["triggered"], True, 0.10, 1200.1)
        self.assertIn("peak RSS is above 1.2 GB", rss["reasons"])

    def test_style_drop_and_locked_floor(self):
        control, treatment = passing_rows()
        treatment[1]["official"] = dict(treatment[1]["official"])
        treatment[1]["official"]["matched"] = 70
        treatment[1]["style_code"] = "Rock"
        control[1]["style_code"] = "Rock"
        gate = development_gate(control, treatment, ["triggered"], True, 0.10, 700.0)
        self.assertGreater(gate["style_drops"]["Rock"], 0.05)
        self.assertFalse(gate["passed"])
        self.assertFalse(locked_regressed(LOCKED_MICRO_F_FLOOR))
        self.assertTrue(locked_regressed(LOCKED_MICRO_F_FLOOR - 1e-9))

    def test_production_detector_is_unchanged(self):
        import json
        manifest = json.loads((RESEARCH / "backend_04k_manifest.json").read_text(encoding="utf-8"))
        relative = "services/detectors/madmom_detector.py"
        digest = hashlib.sha256((BACKEND / relative).read_bytes()).hexdigest()
        self.assertEqual(digest, manifest["model_files"]["config_sha256"][relative])
        detector = (BACKEND / relative).read_text(encoding="utf-8")
        self.assertIn("DBNBeatTrackingProcessor(fps=100)", detector)
        self.assertNotIn("correct=False", detector)
        for root in (BACKEND / "services", BACKEND / "blueprints", REPO / "src", REPO / "electron"):
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.suffix.lower() not in {".py", ".ts", ".tsx", ".js", ".mjs"}:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                self.assertNotIn("octave_overestimate", text)
                self.assertNotIn("correct=False", text)


class RunnerIsolationTest(unittest.TestCase):
    def test_treatment_plan_ignores_annotations_and_production_code(self):
        import inspect
        import backend_04n_octave_guard as runner

        source = inspect.getsource(runner.plan_treatment)
        lowered = source.lower()
        self.assertNotIn("jams", lowered)
        self.assertNotIn("annotation", lowered)
        self.assertNotIn("ground", lowered)
        self.assertIn("trigger_decision", source)
        module = inspect.getsource(runner)
        self.assertNotIn("correct=False", module)
        development = inspect.getsource(runner.run_development)
        self.assertNotIn("LOCKED_TEST_IDS", development)
        self.assertNotIn("backend_04k_locked_test_seal", development)
        locked = inspect.getsource(runner.run_locked)
        self.assertIn("locked_run_allowed", locked)


if __name__ == "__main__":
    unittest.main()
