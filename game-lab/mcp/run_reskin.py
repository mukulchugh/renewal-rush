#!/usr/bin/env python3
"""Run Renewal Rush arena reskin via Unreal MCP."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from reskin_arena_script import RESKIN_SCRIPT
from unreal_mcp import UnrealMCP, wait_for_mcp


def main() -> int:
    print("Connecting to Unreal MCP...")
    client = wait_for_mcp(seconds=120)

    toolsets = client.list_toolsets()
    print("Toolsets:\n", toolsets[:2000])
    if "editor_toolset" not in toolsets and "SceneTools" not in toolsets:
        print("ERROR: EditorToolset not loaded. Restart Unreal after enabling the plugin in MyProject.uproject.")
        return 1

    # Stop PIE if a play session is blocking level edits
    try:
        running = client.call_toolset("IsPIERunning", {}, toolset_name="EditorToolset.EditorAppToolset", timeout=60)
        if "true" in running.lower():
            print("Stopping active PIE session...")
            client.call_toolset("StopPIE", {}, toolset_name="EditorToolset.EditorAppToolset", timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"PIE check skipped: {exc}")

    print("\nRunning Renewal Rush reskin script...")
    result = client.execute_tool_script(RESKIN_SCRIPT, timeout=600)
    print("\nResult:\n", result)

    # Capture viewport for verification
    try:
        capture = client.call_toolset(
            "CaptureViewport",
            {"bShowUI": False},
            toolset_name="EditorAppToolset",
            timeout=120,
        )
        out = Path(__file__).parent.parent / "assets" / "arena-reskin-capture.txt"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(capture[:8000])
        print(f"\nViewport capture metadata saved to {out}")
    except Exception as exc:  # noqa: BLE001
        print(f"Viewport capture skipped: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())