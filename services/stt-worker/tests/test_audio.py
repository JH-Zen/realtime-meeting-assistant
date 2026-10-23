import array
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stt_worker import resample


class AudioResamplingTests(unittest.TestCase):
    def test_8k_to_16k_preserves_duration_and_interpolates(self):
        source = array.array("h", [0, 1000, 2000, 3000])
        result = array.array("h", resample(source.tobytes(), 8000, 16000))
        self.assertEqual(list(result), [0, 500, 1000, 1500, 2000, 2500, 3000, 3000])

    def test_48k_to_16k_preserves_duration(self):
        source = array.array("h", [100] * 48000)
        result = array.array("h", resample(source.tobytes(), 48000, 16000))
        self.assertEqual(len(result), 16000)
        self.assertEqual(set(result), {100})

    def test_matching_rate_does_not_alter_samples(self):
        source = array.array("h", [-32768, 0, 32767]).tobytes()
        self.assertEqual(resample(source, 16000, 16000), source)

    def test_empty_audio_is_empty(self):
        self.assertEqual(resample(b"", 8000, 16000), b"")

    def test_invalid_sample_rates_are_rejected(self):
        for source_rate, target_rate in [(0, 16000), (16000, 0), (-1, 16000)]:
            with self.assertRaises(ValueError):
                resample(b"", source_rate, target_rate)


if __name__ == "__main__":
    unittest.main()
