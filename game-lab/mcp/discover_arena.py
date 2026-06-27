#!/usr/bin/env python3
"""Discover arena lights and BP_ShooterCharacter components via MCP."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from unreal_mcp import wait_for_mcp

DISCOVER_SCRIPT = r'''
import json

LEVEL = "/Game/Variant_Shooter/Lvl_ArenaShooter"
BP_CHARACTER = "/Game/Variant_Shooter/Blueprints/BP_ShooterCharacter"

def et(tool, payload):
    r = execute_tool(tool, json.dumps(payload))
    return r["returnValue"] if isinstance(r, dict) and "returnValue" in r else r

def ref_path(obj):
    try:
        return obj["refPath"]
    except (KeyError, TypeError):
        return str(obj)

def run():
    et("editor_toolset.toolsets.scene.SceneTools.load_level", {"level_path": LEVEL})
    actors = et("editor_toolset.toolsets.scene.SceneTools.find_actors", {
        "name": "", "tag": "", "collision_channels": []
    })

    level_actors = []
    for actor in actors:
        label = et("editor_toolset.toolsets.actor.ActorTools.get_label", {"actor": actor})
        comps = []
        for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": actor}):
            cref = ref_path(comp)
            schema = json.loads(et("editor_toolset.toolsets.object.ObjectTools.list_properties", {"instance": comp}))
            keys = list(schema.keys())[:12]
            comps.append({"ref": cref.split(".")[-1], "props": keys})
        level_actors.append({"label": label, "ref": ref_path(actor), "components": comps})

    bp = et("editor_toolset.toolsets.asset.AssetTools.load_asset", {"asset_path": BP_CHARACTER})
    default = et("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object", {"blueprint": bp})
    bp_comps = []
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": default}):
        cref = ref_path(comp)
        schema = json.loads(et("editor_toolset.toolsets.object.ObjectTools.list_properties", {"instance": comp}))
        bp_comps.append({
            "name": cref.split(".")[-1],
            "full": cref,
            "props": list(schema.keys())
        })

    keywords = ("light", "sun", "sky", "fog", "post", "directional", "atmosphere", "cloud")
    lightish = [a for a in level_actors if any(k in a["label"].lower() for k in keywords)]

    return {
        "lightish": lightish,
        "bp_components": bp_comps,
        "all_labels": [a["label"] for a in level_actors]
    }
'''


def main() -> int:
    client = wait_for_mcp(seconds=60)
    try:
        client.call_toolset("StopPIE", {}, toolset_name="EditorToolset.EditorAppToolset", timeout=60)
    except Exception:
        pass
    raw = client.execute_tool_script(DISCOVER_SCRIPT, timeout=300)
    print(raw)
    out = Path(__file__).parent.parent / "data" / "arena-discovery.json"
    # extract JSON from returnValue if wrapped
    text = raw
    if '"returnValue"' in raw:
        try:
            outer = json.loads(raw.strip().split("data: ")[-1] if "data: " in raw else raw)
            if isinstance(outer, dict) and "content" in outer:
                text = outer["content"][0].get("text", raw)
            inner = json.loads(text) if text.startswith("{") else json.loads(json.loads(text))
            out.write_text(json.dumps(inner, indent=2))
        except Exception:
            out.write_text(text)
    else:
        out.write_text(text)
    print(f"\nSaved discovery to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())