#!/usr/bin/env python3
"""Structural checks for Renewal Rush 3D browser prototype."""

from __future__ import annotations

import sys
from pathlib import Path

GAME_LAB = Path(__file__).resolve().parents[1]
HTML = GAME_LAB / "renewal-rush-3d.html"

REQUIRED = [
    "three.module.js",
    "Renewal Rush",
    "CONNECT_MS",
    "GAME_MS",
    "requestPointerLock",
    "Agent Pulse",
    "Draft ready",
    "quivly-logo-forest-white.webp",
    "Chief Renewal Officer",
    "INTEGRATIONS",
    "MAX_ORBS",
    "powerPreference",
    "AudioContext",
    "Full Stack draft",
]


def main() -> int:
    if not HTML.exists():
        print(f"FAIL: missing {HTML}")
        return 1

    text = HTML.read_text(encoding="utf-8")
    missing = [s for s in REQUIRED if s not in text]
    if missing:
        print("FAIL: renewal-rush-3d.html missing:")
        for m in missing:
            print(f"  - {m}")
        return 1

    if "=== false" in text:
        print("FAIL: broken click-handler logic detected")
        return 1

    print("PASS: renewal-rush-3d.html structural validation")
    print(f"  bytes: {HTML.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())