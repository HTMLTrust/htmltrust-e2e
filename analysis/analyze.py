#!/usr/bin/env python3
from collections import defaultdict
import json
from pathlib import Path
import sys


def format_directory_reputation(entries: list[dict]) -> str:
    """Format the independent score reported by each configured directory."""
    formatted = []
    for entry in entries:
        score = entry["trustScore"]
        bar = "#" * int(score * 20)
        formatted.append(
            f"{entry['directoryId']}={score:.3f} {bar} "
            f"(weight={entry['weight']:.2f}, reports={entry['reports']})"
        )
    return "; ".join(formatted)

def main(results_dir: Path) -> None:
    data = json.loads((results_dir / "data.json").read_text())
    sessions = json.loads((results_dir / "session-logs.json").read_text())
    gt = json.loads((results_dir / "ground-truth.json").read_text())

    print("\n" + "=" * 60)
    print("  Directory Reputation Distribution")
    print("=" * 60)
    for a in data["authorSummary"]:
        mal = f" [MAL {a['maliciousPct']*100:.0f}%]" if a["maliciousPct"] > 0 else ""
        reputation = format_directory_reputation(a["directoryReputation"])
        print(f"  {a['name']:15s} ({a['cmsType']:9s}) {reputation}{mal}")

    det = data["detectionStats"]
    print(f"\n{'='*60}\n  Detection: P={det['precision']*100:.1f}% R={det['recall']*100:.1f}% TP={det['tp']} FP={det['fp']} FN={det['fn']}\n{'='*60}")

    stats = data["consumerStats"]
    print(f"\n  Visits: {stats['totalPageVisits']}  Sig OK: {stats['verificationSuccesses']}  Fail: {stats['verificationFailures']}  Votes: {stats['totalVotes']}")

    votes = defaultdict(lambda: {"trust": 0, "distrust": 0})
    for s in sessions:
        for v in s.get("votesCast", []):
            votes[v["authorId"]][v["vote"].lower()] += 1

    print(f"\n{'='*60}\n  Vote Distribution\n{'='*60}")
    for a in data["authorSummary"]:
        t, d = votes[a["authorId"]]["trust"], votes[a["authorId"]]["distrust"]
        print(f"  {a['name']:15s}  trust={t:4d}  distrust={d:4d}  ratio={t/max(t+d,1):.2f}")

    mal_arts = [a for a in gt.get("articles", []) if a.get("isMalicious")]
    if mal_arts:
        print(f"\n{'='*60}\n  Malicious Articles ({len(mal_arts)})\n{'='*60}")
        for a in mal_arts:
            print(f"  - {a['title']}: {a.get('maliciousReason', '?')}")

    print(f"\n  Analysis complete.\n")

if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("results"))
