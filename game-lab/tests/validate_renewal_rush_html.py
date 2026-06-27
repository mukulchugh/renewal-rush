#!/usr/bin/env python3
"""Structural checks for Renewal Rush browser prototype."""

from __future__ import annotations

import sys
from pathlib import Path

GAME_LAB = Path(__file__).resolve().parents[1]
HTML = GAME_LAB / "renewal-rush.html"

REQUIRED = [
    "stack-rail",
    "CONNECT_MS",
    "Full Stack",
    "Draft ready",
    "stackCoverage",
    "quivly-logo-forest-white.webp",
    "Book a demo",
    "Renewal Rookie",
]


def main() -> int:
    if not HTML.exists():
        print(f"FAIL: missing {HTML}")
        return 1

    text = HTML.read_text(encoding="utf-8")
    missing = [s for s in REQUIRED if s not in text]
    if missing:
        print("FAIL: renewal-rush.html missing:")
        for m in missing:
            print(f"  - {m}")
        return 1

    print("PASS: renewal-rush.html structural validation")
    print(f"  bytes: {HTML.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())