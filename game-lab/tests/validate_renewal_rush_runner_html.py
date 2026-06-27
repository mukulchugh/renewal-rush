#!/usr/bin/env python3
"""Structural checks for Renewal Rush runner + fight game."""

from __future__ import annotations

import sys
from pathlib import Path

HTML = Path(__file__).resolve().parents[1] / "renewal-rush-runner.html"

REQUIRED = [
    "FPS Runner",
    "three.module.js",
    "switchLane",
    "shoot",
    "spawnLaserBeam",
    "sfxLaser",
    "KILL STREAK",
    "renewal-rush-runner-best",
    "quivly-logo-forest-white.webp",
    "CHALLENGE_POOL",
    "HURDLE_GAUNTLETS",
    "spawnGauntlet",
    "challenge-box",
    "crosshair",
    "requestPointerLock",
    "GAUNTLET!",
]


def main() -> int:
    if not HTML.exists():
        print(f"FAIL: missing {HTML}")
        return 1
    text = HTML.read_text(encoding="utf-8")
    missing = [s for s in REQUIRED if s not in text]
    if missing:
        print("FAIL: renewal-rush-runner.html missing:")
        for m in missing:
            print(f"  - {m}")
        return 1
    print("PASS: renewal-rush-runner.html structural validation")
    print(f"  bytes: {HTML.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())