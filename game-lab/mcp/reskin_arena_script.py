# Embedded script passed to ProgrammaticToolset.execute_tool_script
RESKIN_SCRIPT = r'''
import json

LEVEL = "/Game/Variant_Shooter/Lvl_ArenaShooter"
BP_CHARACTER = "/Game/Variant_Shooter/Blueprints/BP_ShooterCharacter"
QUIVLY = {"R": 0.388, "G": 0.400, "B": 0.945, "A": 1.0}
DARK = {"R": 0.02, "G": 0.02, "B": 0.04, "A": 1.0}

def et(tool, payload):
    result = execute_tool(tool, json.dumps(payload))
    if isinstance(result, dict) and "returnValue" in result:
        return result["returnValue"]
    return result

def all_actors():
    return et("editor_toolset.toolsets.scene.SceneTools.find_actors", {
        "name": "",
        "tag": "",
        "collision_channels": []
    })

def set_if_supported(comp, values_dict):
    schema = json.loads(et("editor_toolset.toolsets.object.ObjectTools.list_properties", {"instance": comp}))
    filtered = {k: v for k, v in values_dict.items() if k in schema}
    if not filtered:
        return False
    return et("editor_toolset.toolsets.object.ObjectTools.set_properties", {
        "instance": comp,
        "values": json.dumps(filtered)
    })

def tune_actor_components(actor, values_dict, change_key):
    touched = False
    for comp in et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": actor}):
        if set_if_supported(comp, values_dict):
            touched = True
    return change_key if touched else None

def run():
    changes = []

    et("editor_toolset.toolsets.scene.SceneTools.load_level", {"level_path": LEVEL})
    actors = all_actors()

    for actor in actors:
        label = et("editor_toolset.toolsets.actor.ActorTools.get_label", {"actor": actor})
        lower = label.lower()

        if "directional" in lower or lower == "directionallight":
            hit = tune_actor_components(actor, {
                "Intensity": 4.0,
                "LightColor": QUIVLY,
                "Temperature": 6500.0,
                "CastShadows": True
            }, f"directional:{label}")
            if hit:
                changes.append(hit)

        if "skylight" in lower:
            hit = tune_actor_components(actor, {
                "Intensity": 0.35,
                "LightColor": DARK
            }, f"skylight:{label}")
            if hit:
                changes.append(hit)

        if ("fog" in lower and "exponential" in lower) or lower.endswith("heightfog"):
            hit = tune_actor_components(actor, {
                "FogDensity": 0.04,
                "FogHeightFalloff": 0.2,
                "FogInscatteringColor": QUIVLY,
                "StartDistance": 0.0
            }, f"fog:{label}")
            if hit:
                changes.append(hit)

        if "postprocess" in lower.replace(" ", ""):
            hit = tune_actor_components(actor, {
                "bUnbound": True,
                "BloomIntensity": 0.8,
                "VignetteIntensity": 0.45,
                "AutoExposureBias": -1.0
            }, f"ppv:{label}")
            if hit:
                changes.append(hit)

        if "atmosphere" in lower or "cloud" in lower:
            if set_if_supported(actor, {"bHidden": True}):
                changes.append(f"hidden_sky:{label}")

    # Add post-process + fog if missing
    existing_labels = [et("editor_toolset.toolsets.actor.ActorTools.get_label", {"actor": a}) for a in actors]
    if not any("quivly" in l.lower() and "post" in l.lower() for l in existing_labels):
        identity = {
            "rotation": {"x": 0, "y": 0, "z": 0, "w": 1},
            "translation": {"x": 0, "y": 0, "z": 0},
            "scale3D": {"x": 1, "y": 1, "z": 1}
        }
        ppv = et("editor_toolset.toolsets.scene.SceneTools.add_to_scene_from_class", {
            "actor_type": {"refPath": "/Script/Engine.PostProcessVolume"},
            "name": "PPV_QuivlyCommand",
            "xform": identity,
            "snap_to_ground": False
        })
        tune_actor_components(ppv, {
            "bUnbound": True,
            "BloomIntensity": 1.0,
            "VignetteIntensity": 0.5,
            "AutoExposureBias": -1.2
        }, "added:PPV_QuivlyCommand")
        changes.append("added:PPV_QuivlyCommand")

    if not any("fog" in l.lower() for l in existing_labels):
        identity = {
            "rotation": {"x": 0, "y": 0, "z": 0, "w": 1},
            "translation": {"x": 0, "y": 0, "z": 0},
            "scale3D": {"x": 1, "y": 1, "z": 1}
        }
        fog = et("editor_toolset.toolsets.scene.SceneTools.add_to_scene_from_class", {
            "actor_type": {"refPath": "/Script/Engine.ExponentialHeightFog"},
            "name": "Fog_QuivlyDepth",
            "xform": identity,
            "snap_to_ground": False
        })
        tune_actor_components(fog, {
            "FogDensity": 0.05,
            "FogInscatteringColor": QUIVLY,
            "FogHeightFalloff": 0.15
        }, "added:Fog_QuivlyDepth")
        changes.append("added:Fog_QuivlyDepth")

    # Hide gun / weapon meshes on shooter character blueprint
    bp = et("editor_toolset.toolsets.asset.AssetTools.load_asset", {"asset_path": BP_CHARACTER})
    default = et("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object", {"blueprint": bp})
    comps = et("editor_toolset.toolsets.actor.ActorTools.get_components", {"actor": default})
    hidden = []
    for comp in comps:
        try:
            ref = comp["refPath"]
        except (KeyError, TypeError):
            ref = str(comp)
        lower_ref = ref.lower()
        if not any(k in lower_ref for k in ("rifle", "weapon", "gun", "pistol", "arms", "mesh1p")):
            continue
        if set_if_supported(comp, {"bHiddenInGame": True}):
            hidden.append(ref.split(".")[-1])
    et("editor_toolset.toolsets.blueprint.BlueprintTools.compile_blueprint", {"blueprint": bp})
    changes.append(f"hidden_components:{','.join(hidden) if hidden else 'none'}")

    et("editor_toolset.toolsets.asset.AssetTools.save_assets", {"asset_paths": [LEVEL, BP_CHARACTER]})

    return {
        "level": LEVEL,
        "actor_count": len(actors),
        "changes": changes,
        "status": "renewal-rush-lesson-2-applied"
    }
'''