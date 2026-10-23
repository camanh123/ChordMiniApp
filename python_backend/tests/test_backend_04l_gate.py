"""Contract tests for the Madmom correction ablation. No audio and no models."""

import json
import sys
import unittest
from pathlib import Path

RESEARCH = Path(__file__).resolve().parents[1] / "research"
BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(RESEARCH))

from backend_04k_metrics import DEVELOPMENT_IDS, DIAGNOSTIC_IDS, LOCKED_TEST_IDS  # noqa: E402
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
    REPRESENTATIVE_RECORDING_ID,
    TREATMENT,
    acceptance_gate,
    aggregate_beats,
    budget_passed,
    candidate_decision,
    locked_regressed,
    locked_run_allowed,
)


def _passing_styles():
    return {style: {"micro_beat_f_measure": value} for style, value in BASELINE_STYLE_MICRO_F.items()}


class GateTest(unittest.TestCase):
    def test_control_and_treatment_differ_only_by_correction(self):
        self.assertTrue(CONTROL["correct"])
        self.assertFalse(TREATMENT["correct"])
        self.assertEqual({key: value for key, value in CONTROL.items() if key != "correct"}, {key: value for key, value in TREATMENT.items() if key != "correct"})

    def test_threshold_boundaries(self):
        styles = _passing_styles()
        passed = acceptance_gate(0.809300, 0.128905, styles, 0.0, 0.0)
        self.assertTrue(passed["passed"])
        self.assertFalse(acceptance_gate(0.809299, 0.128905, styles, 0.0, 0.0)["passed"])
        self.assertFalse(acceptance_gate(0.809300, 0.128906, styles, 0.0, 0.0)["passed"])
        collapsed = _passing_styles()
        collapsed["SS"] = {"micro_beat_f_measure": round(BASELINE_STYLE_MICRO_F["SS"] - 0.050001, 6)}
        self.assertFalse(acceptance_gate(0.90, 0.01, collapsed, 0.0, 0.0)["passed"])
        borderline = _passing_styles()
        borderline["SS"] = {"micro_beat_f_measure": round(BASELINE_STYLE_MICRO_F["SS"] - 0.05, 6)}
        self.assertTrue(acceptance_gate(0.90, 0.01, borderline, 0.0, 0.0)["passed"])
        self.assertFalse(acceptance_gate(0.90, 0.01, styles, 1.1e-4, 0.0)["passed"])
        self.assertTrue(acceptance_gate(0.90, 0.01, styles, 1e-4, 1e-4)["passed"])

    def test_locked_rule_and_candidate(self):
        self.assertFalse(locked_regressed(LOCKED_BASELINE_MICRO_BEAT_F))
        self.assertFalse(locked_regressed(LOCKED_BASELINE_MICRO_BEAT_F - 1e-4))
        self.assertTrue(locked_regressed(LOCKED_BASELINE_MICRO_BEAT_F - 1e-4 - 1e-9))
        rejected = {"control_integrity": True, "acceptance_gate_passed": False, "budget_passed": True}
        self.assertFalse(locked_run_allowed(rejected))
        self.assertEqual(candidate_decision(rejected, 0.99), "REJECT")
        pending = {"control_integrity": True, "acceptance_gate_passed": True, "budget_passed": True}
        self.assertTrue(locked_run_allowed(pending))
        self.assertEqual(candidate_decision(pending, None), "REJECT")
        self.assertEqual(candidate_decision(pending, LOCKED_BASELINE_MICRO_BEAT_F), "KEEP")
        over_budget = {"control_integrity": True, "acceptance_gate_passed": True, "budget_passed": False}
        self.assertTrue(locked_run_allowed(over_budget))
        self.assertEqual(candidate_decision(over_budget, 0.99), "REJECT")
        self.assertFalse(budget_passed(0.200001, 1000))
        self.assertFalse(budget_passed(0.20, 1200.01))
        self.assertTrue(budget_passed(0.20, 1200))

    def test_stored_development_rows_reaggregate(self):
        evidence = json.loads((RESEARCH / "backend_04k_evidence.json").read_text(encoding="utf-8"))
        rows = []
        for item in evidence["development"]["recordings"]:
            phase = item["metrics"]["beats"].get("phase") or {}
            rows.append({
                "style_code": item["style_code"],
                "official": item["metrics"]["beats"]["official"],
                "half_beat_fraction": phase.get("fraction_near_half_beat"),
                "bpm_error": item["metrics"].get("bpm_error"),
                "assumption_holds": item["metrics"]["beats"]["assumption_holds"],
            })
        aggregate = aggregate_beats(rows)
        stored = evidence["development"]["aggregate"]
        for key in (
            "micro_beat_precision",
            "micro_beat_recall",
            "micro_beat_f_measure",
            "macro_beat_f_measure",
            "macro_half_beat_fraction",
            "macro_bpm_error",
            "extra_beats",
            "missed_beats",
            "greedy_assumption_failures",
        ):
            self.assertEqual(aggregate[key], stored[key])
        self.assertEqual(round(stored["micro_beat_f_measure"], 6), round(BASELINE_MICRO_BEAT_F, 6))
        self.assertEqual(round(stored["macro_half_beat_fraction"], 6), round(BASELINE_MACRO_HALF_BEAT, 6))
        self.assertEqual(stored["duration_weighted_root_accuracy"], BASELINE_DURATION_WEIGHTED_ROOT)
        self.assertEqual(stored["duration_weighted_bare_triad_recall"], BASELINE_DURATION_WEIGHTED_BARE_TRIAD)
        for style, expected in BASELINE_STYLE_MICRO_F.items():
            self.assertEqual(round(evidence["development"]["by_style"][style]["micro_beat_f_measure"], 6), round(expected, 6))
        locked = evidence["locked_test"]["aggregate"]
        self.assertEqual(locked["micro_beat_f_measure"], LOCKED_BASELINE_MICRO_BEAT_F)
        self.assertEqual(locked["macro_beat_f_measure"], LOCKED_BASELINE_MACRO_BEAT_F)
        self.assertEqual(locked["macro_half_beat_fraction"], LOCKED_BASELINE_MACRO_HALF_BEAT)
        self.assertNotIn("recordings", evidence["locked_test"])

    def test_representative_recording_is_fixed_from_duration(self):
        manifest = json.loads((RESEARCH / "backend_04k_manifest.json").read_text(encoding="utf-8"))
        closest = min(DEVELOPMENT_IDS, key=lambda recording_id: abs(manifest["recordings"][recording_id]["audio"]["duration_seconds"] - 45.0))
        self.assertEqual(closest, REPRESENTATIVE_RECORDING_ID)
        self.assertNotIn(REPRESENTATIVE_RECORDING_ID, LOCKED_TEST_IDS)
        self.assertNotIn(REPRESENTATIVE_RECORDING_ID, DIAGNOSTIC_IDS)

    def test_production_detector_is_unchanged_and_correction_stays_on(self):
        manifest = json.loads((RESEARCH / "backend_04k_manifest.json").read_text(encoding="utf-8"))
        expected = manifest["model_files"]["config_sha256"]
        for relative, digest in expected.items():
            payload = (BACKEND / relative).read_bytes()
            import hashlib
            self.assertEqual(hashlib.sha256(payload).hexdigest(), digest)
        detector = (BACKEND / "services" / "detectors" / "madmom_detector.py").read_text(encoding="utf-8")
        self.assertIn("beat_tracker = DBNBeatTrackingProcessor(fps=100)", detector)
        self.assertNotIn("correct=False", detector)
        scanned = []
        for root in (BACKEND / "services", BACKEND / "blueprints", REPO / "src", REPO / "electron", REPO / ".github"):
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.suffix.lower() not in {".py", ".ts", ".tsx", ".js", ".mjs", ".yml", ".yaml"}:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                scanned.append(path)
                self.assertNotIn("correct=False", text)
                self.assertNotIn("correct=false", text)
        self.assertGreater(len(scanned), 10)


if __name__ == "__main__":
    unittest.main()
