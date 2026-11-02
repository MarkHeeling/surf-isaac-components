"""Tests for files/ngc_latest_tag.py (no network): python3 -m unittest discover -s tests"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "files"))
from ngc_latest_tag import newest  # noqa: E402

# Tags on nvcr.io/nvidia/isaac-sim as of 2026-11-02 (signature/sbom tags trimmed).
ISAAC_SIM = [
    "2020.1_ea", "2021.2.1", "2022.1.1", "2022.2.0", "2022.2.1",
    "4.0.0", "4.5.0", "5.0.0", "5.1.0", "6.0.0-dev2", "6.0.0-dev3", "6.0.0",
    "6.0.1", "6.1.0", "6.2.0.1", "6.2.0",
    "sha256-48ccef298a8a7be20a3325a8e9c76546b5bc18ee1480e9594a5977cd2f04a54a.sig",
]
ISAAC_LAB = [
    "2.0.0", "2.3.2", "3.0.0", "3.0.0-beta1", "3.0.0-beta2", "3.0.0-beta2-post1",
    "3.0.0-kitless", "3.0.0-rc1", "3.0.0-rc1-kitless",
]


class NewestTag(unittest.TestCase):
    def test_year_tags_do_not_win(self):
        # 2022.2.1 was picked on 2026-11-02: it has no runheadless.sh -> crash loop.
        self.assertEqual(newest(ISAAC_SIM), "6.2.0.1")

    def test_hotfix_beats_its_release(self):
        self.assertEqual(newest(["6.2.0", "6.2.0.1", "6.1.0"]), "6.2.0.1")

    def test_release_beats_prerelease_of_same_version(self):
        self.assertEqual(newest(ISAAC_LAB, prerelease=True), "3.0.0")
        self.assertEqual(newest(["6.3.0-rc1", "6.2.0"]), "6.2.0")
        self.assertEqual(newest(["6.3.0-rc1", "6.2.0"], prerelease=True), "6.3.0-rc1")

    def test_only_year_tags(self):
        self.assertIsNone(newest(["2022.2.1", "latest"]))


if __name__ == "__main__":
    unittest.main()
