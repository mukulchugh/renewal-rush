# MCP pass 3 — label account orbs, hide spawners, Quivly arena for Renewal Rush 3D
SETUP_3D_SCRIPT = r'''
import json

LEVEL = "/Game/Variant_Shooter/Lvl_ArenaShooter"
BP_CHARACTER = "/Game/Variant_Shooter/Blueprints/BP_ShooterCharacter"
QUIVLY = {"R": 0.388, "G": 0.400, "B": 0.945, "A": 1.0}
ORB_COLORS = {
    "healthy": {"R": 0.204, "G": 0.827, "B": 0.600, "A": 1.0},
    "expansion": {"R": 0.984, "G": 0.749, "B": 0.141, "A": 1.0},
    "atRisk": {"R": 0.973, "G": 0.443, "B": 0.443, "A": 1.0},
}
ACCOUNT_NAMES = ["Vertex Labs", "CloudNine", "DataForge", "Pulse AI", "Stackline"]

def et(tool, payload):
    r = execute_tool(tool, json.dumps(payload))
    return r["returnValue"] if isinstance(r, dict) and "returnValue" in r else r

def ref_path(obj):
    try:
        return obj["refPath"]
    except (KeyError, TypeError):
        return str(obj)

def find_by_label(label):
    actors = et("editor_toolset.toolsets.scene.SceneTools.find_actors", {
        "name": label, "tag": "", "collision_channels": []
    })
    for actor in actors:
        if et("editor_toolset.toolsets.actor.ActorTools.get_label", {"actor": actor}) == label:
            return actor
    return None

def set_if_supported(obj, values_dict):
    schema = json.loads(et("editor_toolset.toolsets.object.ObjectTools.list_properties", {"instance": obj}))
    filtered = {k: v for k, v in values_dict.items() if k in schema}
    if not filtered:
        return False
    return et("editor_toolset.toolsets.object.ObjectTools.set_properties", {
        "instance": obj,
        "values": json.dumps(filtered)
    })

def tune_components(actor, values_dict):
    touched = []
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": actor}):
        cref = ref_path(comp).split(".")[-1]
        if set_if_supported(comp, values_dict):
            touched.append(cref)
    return touched

def hide_actor(label):
    actor = find_by_label(label)
    if not actor:
        return None
    if set_if_supported(actor, {"bHidden": True}):
        return label
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": actor}):
        if set_if_supported(comp, {"bVisible": False, "bHiddenInGame": True}):
            return label
    return None

def run():
    changes = []
    et("editor_toolset.toolsets.scene.SceneTools.load_level", {"level_path": LEVEL})

    # Rename wobble targets → account orbs with status colors
    status_cycle = ["atRisk", "expansion", "healthy", "atRisk", "expansion"]
    for i, base in enumerate(["BP_WobbleTarget", "BP_WobbleTarget2", "BP_WobbleTarget3", "BP_WobbleTarget4", "BP_WobbleTarget5"]):
        actor = find_by_label(base)
        if not actor:
            continue
        new_label = "AccountOrb_" + ACCOUNT_NAMES[i % len(ACCOUNT_NAMES)].replace(" ", "")
        et("editor_toolset.toolsets.actor.ActorTools.set_label", {"actor": actor, "label": new_label})
        color = ORB_COLORS[status_cycle[i]]
        touched = tune_components(actor, {
            "lightColor": color,
            "intensity": 2.5,
            "emissiveColor": color,
            "emissiveIntensity": 1.2,
        })
        changes.append("orb:" + new_label + ":" + status_cycle[i] + (":" + ",".join(touched) if touched else ""))

    # Hide NPC spawners — Renewal Rush uses static orbs, not enemy waves
    for spawner_label in ("BP_NPCSpawner", "BP_NPCSpawner2", "BP_NPCSpawner_C", "NPCSpawner"):
        hit = hide_actor(spawner_label)
        if hit:
            changes.append("hidden_spawner:" + hit)

    # Hide outdoor sky clutter
    for sky_label in ("SkyAtmosphere", "VolumetricCloud", "SM_SkySphere"):
        hit = hide_actor(sky_label)
        if hit:
            changes.append("hidden:" + hit)

    # Quivly post-process
    for ppv_label in ("PostProcessVolume", "PPV_QuivlyCommand"):
        ppv = find_by_label(ppv_label)
        if ppv:
            set_if_supported(ppv, {"bUnbound": True, "blendWeight": 1.0})
            tune_components(ppv, {"bloomIntensity": 1.0, "vignetteIntensity": 0.55, "autoExposureBias": -1.2})

    # Hide first-person gun mesh
    bp = et("editor_toolset.toolsets.asset.AssetTools.load_asset", {"asset_path": BP_CHARACTER})
    default = et("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object", {"blueprint": bp})
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": default}):
        cref = ref_path(comp)
        if "FirstPersonMesh" in cref:
            set_if_supported(comp, {"bHiddenInGame": True, "bVisible": False})
            changes.append("hidden_weapon:FirstPersonMesh")
    et("editor_toolset.toolsets.blueprint.BlueprintTools.compile_blueprint", {"blueprint": bp})

    et("editor_toolset.toolsets.asset.AssetTools.save_assets", {"asset_paths": [LEVEL, BP_CHARACTER]})

    return {
        "status": "renewal-rush-3d-setup",
        "orbCount": len([c for c in changes if c.startswith("orb:")]),
        "changes": changes
    }
'''