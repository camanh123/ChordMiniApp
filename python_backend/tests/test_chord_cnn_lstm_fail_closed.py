"""Missing Chord-CNN-LSTM assets must fail closed.

These tests do not load the real network. They prove a missing directory,
missing weights, or an import failure cannot report success or the fabricated
C-F-G-C sequence that used to be substituted for a model.
"""

import sys
import tempfile
import unittest
import wave
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from services.detectors.chord_cnn_lstm_detector import (  # noqa: E402
    CHORD_CNN_LSTM_WEIGHTS,
    MIN_WEIGHT_BYTES,
    ChordCNNLSTMDetectorService,
)

FABRICATED_CHORDS = [
    {"start": 0.0, "end": 2.0, "chord": "C:maj", "confidence": 1.0},
    {"start": 2.0, "end": 4.0, "chord": "F:maj", "confidence": 1.0},
    {"start": 4.0, "end": 6.0, "chord": "G:maj", "confidence": 1.0},
    {"start": 6.0, "end": 8.0, "chord": "C:maj", "confidence": 1.0},
]


def assert_explicit_failure(test_case, result):
    test_case.assertFalse(result["success"])
    test_case.assertIsInstance(result.get("error"), str)
    test_case.assertTrue(result["error"].strip())
    test_case.assertNotIn("chords", result)
    test_case.assertNotEqual(result.get("chords"), FABRICATED_CHORDS)
    test_case.assertEqual(result.get("model_used"), "chord-cnn-lstm")
    serialized = str(result)
    for fabricated in ("C:maj", "F:maj", "G:maj"):
        test_case.assertNotIn(fabricated, serialized)


class ChordCNNLSTMFailClosedTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory()
        self.model_dir = Path(self._temporary.name)
        self.audio_path = self.model_dir / "silence.wav"
        with wave.open(str(self.audio_path), "w") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(22050)
            handle.writeframes(b"\x00\x00" * 22050)

    def tearDown(self):
        sys.modules.pop("chord_recognition", None)
        self._temporary.cleanup()

    def test_missing_directory_is_unavailable(self):
        missing = self.model_dir / "does-not-exist"
        detector = ChordCNNLSTMDetectorService(str(missing))
        self.assertFalse(detector.is_available())
        assert_explicit_failure(self, detector.recognize_chords(str(self.audio_path)))

    def test_missing_weights_are_unavailable(self):
        (self.model_dir / "chord_recognition.py").write_text(
            "def chord_recognition(*args, **kwargs):\n    raise AssertionError('weights were skipped')\n",
            encoding="utf-8",
        )
        detector = ChordCNNLSTMDetectorService(str(self.model_dir))
        self.assertFalse(detector.is_available())
        assert_explicit_failure(self, detector.recognize_chords(str(self.audio_path)))

    def test_import_error_is_unavailable_and_not_fabricated(self):
        (self.model_dir / "chord_recognition.py").write_text(
            "raise ImportError('simulated missing chord dependency')\n",
            encoding="utf-8",
        )
        for relative in CHORD_CNN_LSTM_WEIGHTS:
            weight_path = self.model_dir / relative
            weight_path.parent.mkdir(parents=True, exist_ok=True)
            weight_path.write_bytes(b"\x00" * MIN_WEIGHT_BYTES)
        detector = ChordCNNLSTMDetectorService(str(self.model_dir))
        self.assertFalse(detector.is_available())
        assert_explicit_failure(self, detector.recognize_chords(str(self.audio_path)))

        # Even a stale availability flag must not turn an import failure
        # into a successful chord list.
        sys.modules.pop("chord_recognition", None)
        forced = ChordCNNLSTMDetectorService(str(self.model_dir))
        forced._available = True
        assert_explicit_failure(self, forced.recognize_chords(str(self.audio_path)))

    def test_source_no_longer_contains_the_mock_response(self):
        source = Path(
            BACKEND_ROOT / "services" / "detectors" / "chord_cnn_lstm_detector.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn("Using mock chord data", source)
        self.assertNotIn("TEMPORARY: Return True", source)
        self.assertNotIn('"chord": "C:maj"', source)


if __name__ == "__main__":
    unittest.main()
