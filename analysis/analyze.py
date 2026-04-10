#!/usr/bin/env python3
"""Analyze HTMLTrust E2E simulation results."""
import json, sys
from pathlib import Path
from collections import defaultdict

def main(results_dir: Path) -> None:
    data = json.loads((results_dir / "data.json").read_text())
    sessions = json.loads((results_dir / "session-logs.json").read_text())
    gt = json.loads((results_dir / "ground-truth.json").read_text())

    print("\n" + "=" * 60)
    print("  Trust Score Distribution")
    print("=" * 60)
    for a in data["authorSummary"]:
        bar = "#" * int(a["trustScore"] * 40)
        mal = f" [MAL {a['maliciousPct']*100:.0f}%]" if a["maliciousPct"] > 0 else ""
        print(f"  {a['name']:15s} ({a['cmsType']:9s}) {a['trustScore']:.3f} {bar}{mal}")

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
