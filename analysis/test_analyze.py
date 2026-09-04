import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout

from analyze import main


class AnalyzeTest(unittest.TestCase):
    def test_reports_each_directory_reputation(self) -> None:
        data = {
            "authorSummary": [{
                "authorId": "author-1",
                "name": "Author 1",
                "cmsType": "wordpress",
                "maliciousPct": 1.0,
                "directoryReputation": [
                    {"directoryId": "alpha", "weight": 0.6, "trustScore": 0.52, "reports": 0},
                    {"directoryId": "beta", "weight": 0.4, "trustScore": 0.36, "reports": 3},
                ],
            }],
            "detectionStats": {"precision": 1.0, "recall": 1.0, "tp": 1, "fp": 0, "fn": 0},
            "consumerStats": {
                "totalPageVisits": 2,
                "verificationSuccesses": 2,
                "verificationFailures": 0,
                "totalVotes": 1,
            },
        }
        sessions = [{"votesCast": [{"authorId": "author-1", "vote": "TRUST"}]}]
        ground_truth = {
            "articles": [{
                "title": "Example",
                "authorId": "author-1",
                "isMalicious": True,
                "maliciousReason": "fixture",
            }],
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            results_dir = Path(temporary_directory)
            (results_dir / "data.json").write_text(json.dumps(data), encoding="utf-8")
            (results_dir / "session-logs.json").write_text(json.dumps(sessions), encoding="utf-8")
            (results_dir / "ground-truth.json").write_text(json.dumps(ground_truth), encoding="utf-8")
            output = io.StringIO()
            with redirect_stdout(output):
                main(results_dir)

        rendered = output.getvalue()
        self.assertIn("alpha=0.520", rendered)
        self.assertIn("beta=0.360", rendered)
        self.assertIn("weight=0.60", rendered)
        self.assertIn("reports=3", rendered)


if __name__ == "__main__":
    unittest.main()
