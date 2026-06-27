#!/usr/bin/env python3
"""Copy full research artifacts to goal scratch dir for audit."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

GAME_LAB = Path(__file__).resolve().parents[1]

DEFAULT_SCRATCH = Path(
    "/var/folders/s8/t0cvl8cx6532dfcfllc0v1yc0000gn/T/grok-goal-1e3f1e2d560a/implementer"
)

COPY_PATHS = [
    GAME_LAB / "data/quivly-landing.json",
    GAME_LAB / "data/premise-research-evidence.json",
    GAME_LAB / "data/game-script.json",
    GAME_LAB / "data/arena-discovery.json",
    GAME_LAB / ".firecrawl/pagertron.md",
    GAME_LAB / ".firecrawl/search-saas-mini-games.json",
    GAME_LAB / ".firecrawl/search-wizlympics.json",
    GAME_LAB / ".firecrawl/search-toggl-sim.json",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scratch", type=Path, default=DEFAULT_SCRATCH)
    args = parser.parse_args()
    scratch: Path = args.scratch
    evidence_dir = scratch / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    manifest: list[dict] = []
    missing: list[str] = []

    for src in COPY_PATHS:
        rel = src.relative_to(GAME_LAB)
        dest = evidence_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not src.exists():
            missing.append(str(rel))
            continue
        shutil.copy2(src, dest)
        manifest.append({"source": str(rel), "dest": str(dest), "bytes": dest.stat().st_size})

    game_script = json.loads((GAME_LAB / "data/game-script.json").read_text())
    summary = {
        "verification": "premise-research-goal",
        "status": game_script["meta"]["status"],
        "recommendedPremise": game_script["premiseResearch"]["recommendedPremise"],
        "oneLiner": game_script["meta"]["oneLiner"],
        "platformRecommendation": game_script["meta"]["platformRecommendation"],
        "benchmarkCount": len(game_script["premiseResearch"]["benchmarks"]),
        "evidenceFile": game_script["premiseResearch"].get("evidenceFile"),
        "copiedArtifacts": manifest,
        "missingArtifacts": missing,
    }

    (scratch / "research-summary.json").write_text(json.dumps(summary, indent=2))
    (scratch / "quivly-landing-full.json").write_text(
        (GAME_LAB / "data/quivly-landing.json").read_text()
    )

    if missing:
        print("FAIL: missing artifacts")
        for path in missing:
            print(f"  - {path}")
        return 1

    print(f"PASS: copied {len(manifest)} artifacts to {evidence_dir}")
    print(f"  summary: {scratch / 'research-summary.json'}")
    print(f"  full landing: {scratch / 'quivly-landing-full.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())