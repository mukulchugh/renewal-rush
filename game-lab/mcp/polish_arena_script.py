# MCP pass 2 — tuned property names from arena-discovery.json
POLISH_SCRIPT = r'''
import json

LEVEL = "/Game/Variant_Shooter/Lvl_ArenaShooter"
BP_CHARACTER = "/Game/Variant_Shooter/Blueprints/BP_ShooterCharacter"
BP_WEAPON_RIFLE = "/Game/Variant_Shooter/Blueprints/Pickups/Weapons/BP_ShooterWeapon_Rifle"
QUIVLY = {"R": 0.388, "G": 0.400, "B": 0.945, "A": 1.0}
DARK = {"R": 0.02, "G": 0.02, "B": 0.04, "A": 1.0}
IDENTITY = {
    "rotation": {"x": 0, "y": 0, "z": 0, "w": 1},
    "translation": {"x": 0, "y": 0, "z": 0},
    "scale3D": {"x": 1, "y": 1, "z": 1}
}

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

    # --- Lighting: camelCase props from discovery ---
    sun = find_by_label("DirectionalLight")
    if sun:
        touched = tune_components(sun, {
            "intensity": 3.5,
            "lightColor": QUIVLY,
            "temperature": 6500.0,
            "castShadows": True
        })
        if touched:
            changes.append("sun:" + ",".join(touched))

    sky = find_by_label("SkyLight")
    if sky:
        touched = tune_components(sky, {
            "intensity": 0.25,
            "lightColor": DARK,
            "bLowerHemisphereIsBlack": True
        })
        if touched:
            changes.append("skylight:" + ",".join(touched))

    fog = find_by_label("ExponentialHeightFog")
    if fog:
        touched = tune_components(fog, {
            "fogDensity": 0.045,
            "fogHeightFalloff": 0.18,
            "fogInscatteringLuminance": QUIVLY,
            "startDistance": 0.0
        })
        if touched:
            changes.append("fog:" + ",".join(touched))

    # Hide outdoor sky assets
    for sky_label in ("SkyAtmosphere", "VolumetricCloud", "SM_SkySphere"):
        hit = hide_actor(sky_label)
        if hit:
            changes.append("hidden:" + hit)

    # Post-process: existing + Quivly volume
    for ppv_label in ("PostProcessVolume", "PPV_QuivlyCommand"):
        ppv = find_by_label(ppv_label)
        if ppv:
            if set_if_supported(ppv, {"bUnbound": True, "blendWeight": 1.0}):
                changes.append("ppv_actor:" + ppv_label)
            touched = tune_components(ppv, {
                "bloomIntensity": 0.9,
                "vignetteIntensity": 0.5,
                "autoExposureBias": -1.0
            })
            if touched:
                changes.append("ppv_comp:" + ppv_label + ":" + ",".join(touched))

    if not find_by_label("PPV_QuivlyCommand"):
        ppv = et("editor_toolset.toolsets.scene.SceneTools.add_to_scene_from_class", {
            "actor_type": {"refPath": "/Script/Engine.PostProcessVolume"},
            "name": "PPV_QuivlyCommand",
            "xform": IDENTITY,
            "snap_to_ground": False
        })
        set_if_supported(ppv, {"bUnbound": True, "blendWeight": 1.0})
        tune_components(ppv, {"bloomIntensity": 1.0, "vignetteIntensity": 0.55, "autoExposureBias": -1.2})
        changes.append("added:PPV_QuivlyCommand")

    # Hide first-person weapon view mesh (arms+gun FP mesh from parent class)
    bp = et("editor_toolset.toolsets.asset.AssetTools.load_asset", {"asset_path": BP_CHARACTER})
    default = et("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object", {"blueprint": bp})
    hidden = []
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": default}):
        cref = ref_path(comp)
        if "FirstPersonMesh" in cref:
            if set_if_supported(comp, {"bHiddenInGame": True, "bVisible": False}):
                hidden.append("FirstPersonMesh")
    et("editor_toolset.toolsets.blueprint.BlueprintTools.compile_blueprint", {"blueprint": bp})

    # Also hide rifle weapon mesh in weapon blueprint (held weapon when picked up)
    try:
        wbp = et("editor_toolset.toolsets.asset.AssetTools.load_asset", {"asset_path": BP_WEAPON_RIFLE})
        wdefault = et("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object", {"blueprint": wbp})
        for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": wdefault}):
            cref = ref_path(comp)
            schema = json.loads(et("editor_toolset.toolsets.object.ObjectTools.list_properties", {"instance": comp}))
            if "staticMesh" in schema or "skeletalMesh" in schema:
                if set_if_supported(comp, {"bHiddenInGame": True, "bVisible": False}):
                    hidden.append(cref.split(".")[-1])
        et("editor_toolset.toolsets.blueprint.BlueprintTools.compile_blueprint", {"blueprint": wbp})
        et("editor_toolset.toolsets.asset.AssetTools.save_assets", {"asset_paths": [BP_WEAPON_RIFLE]})
    except Exception:
        pass

    changes.append("hidden_weapon:" + (",".join(hidden) if hidden else "none"))

    et("editor_toolset.toolsets.asset.AssetTools.save_assets", {"asset_paths": [LEVEL, BP_CHARACTER]})

    return {
        "status": "renewal-rush-polish-pass-2",
        "changes": changes
    }
'''