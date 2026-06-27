#!/usr/bin/env python3
"""Run Renewal Rush polish pass 2 via Unreal MCP."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from polish_arena_script import POLISH_SCRIPT
from unreal_mcp import wait_for_mcp


def main() -> int:
    print("Connecting to Unreal MCP...")
    client = wait_for_mcp(seconds=60)

    try:
        running = client.call_toolset("IsPIERunning", {}, toolset_name="EditorToolset.EditorAppToolset", timeout=30)
        if "true" in running.lower():
            print("Stopping PIE...")
            client.call_toolset("StopPIE", {}, toolset_name="EditorToolset.EditorAppToolset", timeout=90)
    except Exception as exc:  # noqa: BLE001
        print(f"PIE check: {exc}")

    print("Running polish pass 2...")
    result = client.execute_tool_script(POLISH_SCRIPT, timeout=600)
    print(result)

    try:
        capture = client.call_toolset(
            "CaptureViewport",
            {"bShowUI": False, "captureTransform": None},
            toolset_name="EditorToolset.EditorAppToolset",
            timeout=120,
        )
        out = Path(__file__).parent.parent / "assets" / "arena-polish-capture.txt"
        out.write_text(capture[:12000])
        print(f"Viewport capture saved to {out}")
    except Exception as exc:  # noqa: BLE001
        print(f"Capture skipped: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())