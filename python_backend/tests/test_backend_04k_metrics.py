"""Contract tests for the sealed GuitarSet baseline. No audio and no models."""

import sys
import unittest
from pathlib import Path

RESEARCH = Path(__file__).resolve().parents[1] / "research"
sys.path.insert(0, str(RESEARCH))

from backend_04k_metrics import (  # noqa: E402
    DEVELOPMENT_IDS,
    DIAGNOSTIC_IDS,
    ERRATA_IDS,
    LOCKED_TEST_IDS,
    assert_split_integrity,
    chord_extensions,
    maximum_cardinality_match,
    score_beats,
)


class SplitContractTest(unittest.TestCase):
    def test_counts_and_errata(self):
        assert_split_integrity()
        self.assertEqual(len(DEVELOPMENT_IDS), 40)
        self.assertEqual(len(LOCKED_TEST_IDS), 20)
        self.assertEqual(len(DIAGNOSTIC_IDS), 5)
        self.assertEqual(len(set(DEVELOPMENT_IDS)), 40)
        self.assertEqual(len(set(LOCKED_TEST_IDS)), 20)
        for recording_id in ERRATA_IDS:
            self.assertNotIn(recording_id, DEVELOPMENT_IDS)
            self.assertNotIn(recording_id, LOCKED_TEST_IDS)
            self.assertNotIn(recording_id, DIAGNOSTIC_IDS)


class ChordContractTest(unittest.TestCase):
    def test_seventh_is_not_exact_and_not_a_swap(self):
        reference = [{"start": 0.0, "end": 10.0, "chord": "E:min"}]
        predicted = [{"start": 0.0, "end": 10.0, "chord": "E:min7"}]
        extra = chord_extensions(reference, predicted, 10.0)
        self.assertEqual(extra["seventh_versus_triad_seconds"], 10.0)
        self.assertEqual(extra["same_root_major_minor_swap_seconds"], 0.0)
        self.assertEqual(extra["half_diminished_confusion_seconds"], 0.0)

    def test_same_root_swap_is_separate_from_sevenths(self):
        reference = [{"start": 0.0, "end": 4.0, "chord": "E:min"}]
        predicted = [{"start": 0.0, "end": 4.0, "chord": "E:maj"}]
        extra = chord_extensions(reference, predicted, 4.0)
        self.assertEqual(extra["same_root_major_minor_swap_seconds"], 4.0)
        self.assertEqual(extra["seventh_versus_triad_seconds"], 0.0)

    def test_enharmonic_hdim_is_not_confusion(self):
        reference = [{"start": 0.0, "end": 3.0, "chord": "C#:hdim7"}]
        kept = chord_extensions(reference, [{"start": 0.0, "end": 3.0, "chord": "Db:hdim7"}], 3.0)
        confused = chord_extensions(reference, [{"start": 0.0, "end": 3.0, "chord": "C#:min7"}], 3.0)
        self.assertEqual(kept["half_diminished_kept_seconds"], 3.0)
        self.assertEqual(kept["half_diminished_confusion_seconds"], 0.0)
        self.assertEqual(confused["half_diminished_confusion_seconds"], 3.0)
        self.assertEqual(confused["half_diminished_named_substitution_seconds"], 3.0)

    def test_no_chord_false_positive(self):
        reference = [{"start": 0.0, "end": 2.0, "chord": "C:maj"}]
        predicted = [{"start": 0.0, "end": 2.0, "chord": "N"}]
        extra = chord_extensions(reference, predicted, 2.0)
        self.assertEqual(extra["no_chord_false_positive_seconds"], 2.0)
        self.assertEqual(extra["no_chord_false_negative_seconds"], 0.0)


class BeatMatcherTest(unittest.TestCase):
    def test_wide_gaps_keep_the_04i_greedy_matcher(self):
        scored = score_beats([0.0, 1.0], [0.02, 1.01], 60.0)
        self.assertTrue(scored["assumption_holds"])
        self.assertEqual(scored["official"]["matcher"], "greedy_04i")
        self.assertEqual(scored["official"]["matched"], 2)

    def test_maximum_cardinality_when_one_detection_covers_two_references(self):
        matched = maximum_cardinality_match([0.0, 0.10], [0.05], 0.07)
        self.assertEqual(matched["matched"], 1)
        self.assertEqual(matched["extra"], 0)
        self.assertEqual(matched["missed"], 1)

    def test_close_gaps_do_not_claim_the_greedy_assumption(self):
        scored = score_beats([0.0, 0.10], [0.02, 0.12], 120.0)
        self.assertFalse(scored["assumption_holds"])
        self.assertEqual(scored["official"]["matcher"], "maximum_cardinality_kuhn")
        self.assertEqual(scored["greedy"]["matched"], scored["optimal"]["matched"])


if __name__ == "__main__":
    unittest.main()
