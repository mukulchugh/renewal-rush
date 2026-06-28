// assets.js — optional real-art layer (Track B). The procedural city is the
// default and the fallback; this module lets authored art override it piece by
// piece WITHOUT touching the rest of the code.
//
// How to use: drop files in `public/assets/...`, add the URL(s) to the manifest
// below, and the matching surface/model upgrades on next load. Any key you leave
// out stays procedural — every entry is independently optional, so you can ship
// one real texture set at a time.
//
// Art is RUNTIME-loaded (not bundled): it never counts against the JS bundle
// budget, and the glTF loader is dynamically imported so it only ships if a model
// is actually requested.
//
// This is the "real photoreal" seam: authored albedo + NORMAL + roughness/AO maps
// (e.g. Poly Haven) are the single biggest fidelity jump over flat procedural
// surfaces — far beyond what post-processing alone can do.

import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";

// ── Manifests (fill in as art lands; empty = procedural fallback) ─────────────

// PBR texture sets. Shape per key:
//   { albedo, normal, orm?, roughness?, ao?, invertY? }
//   • orm  = a single packed Occlusion(R)/Roughness(G)/Metallic(B) map (glTF style)
//   • or supply roughness/ao separately if you don't have a packed ORM
// Real CC0 sets from ambientCG (NormalGL = OpenGL convention = Babylon default, no invertY).
const TEX = {
  asphalt: {
    albedo: "/assets/asphalt031/Asphalt031_2K-JPG_Color.jpg",
    normal: "/assets/asphalt031/Asphalt031_2K-JPG_NormalGL.jpg",
    roughness: "/assets/asphalt031/Asphalt031_2K-JPG_Roughness.jpg",
    ao: "/assets/asphalt031/Asphalt031_2K-JPG_AmbientOcclusion.jpg",
  },
  sidewalk: {
    albedo: "/assets/concrete034/Concrete034_2K-JPG_Color.jpg",
    normal: "/assets/concrete034/Concrete034_2K-JPG_NormalGL.jpg",
    roughness: "/assets/concrete034/Concrete034_2K-JPG_Roughness.jpg",
  },
  paver: {
    albedo: "/assets/pavingstones150/PavingStones150_2K-JPG_Color.jpg",
    normal: "/assets/pavingstones150/PavingStones150_2K-JPG_NormalGL.jpg",
    roughness: "/assets/pavingstones150/PavingStones150_2K-JPG_Roughness.jpg",
    ao: "/assets/pavingstones150/PavingStones150_2K-JPG_AmbientOcclusion.jpg",
  },
};

// A real prefiltered environment (.env) — overrides the procedural sky-probe IBL
// in world.js for sharper, authored reflections. e.g. "/assets/env/city.env".
const ENV_URL = "";

// GLB/glTF models keyed by logical name. e.g. strategicHQ: "/assets/buildings/tower.glb".
const MODELS = {};

// ── Texture sets ──────────────────────────────────────────────────────────────

// Apply an authored PBR set to a PBRMaterial. Returns true if art was applied,
// false if the key is absent (caller keeps its procedural look). Tiling (uScale/
// vScale) should match whatever the procedural texture used so seams line up.
// keepAlbedo: apply only the relief/roughness maps (normal, ORM/AO) and leave the
// material's existing albedo + tint alone — used where albedo carries meaning
// (e.g. health-coded building facades) but the surface still wants real relief.
export function applyTextureSet(mat, key, scene, { uScale = 1, vScale = 1, keepAlbedo = false } = {}) {
  const set = TEX[key];
  if (!set || !mat) return false;
  const mk = (url) => {
    const t = new Texture(url, scene);
    t.uScale = uScale; t.vScale = vScale;
    t.wrapU = Texture.WRAP_ADDRESSMODE; t.wrapV = Texture.WRAP_ADDRESSMODE;
    try { t.anisotropicFilteringLevel = 16; } catch { /* noop */ }
    return t;
  };
  try {
    if (set.albedo && !keepAlbedo) { mat.albedoTexture = mk(set.albedo); mat.albedoColor.set(1, 1, 1); }
    if (set.normal) { mat.bumpTexture = mk(set.normal); mat.invertNormalMapY = !!set.invertY; }
    if (set.orm) {
      mat.metallicTexture = mk(set.orm);
      mat.useAmbientOcclusionFromMetallicTextureRed = true;
      mat.useRoughnessFromMetallicTextureGreen = true;
      mat.useMetallnessFromMetallicTextureBlue = true;
    } else {
      if (set.roughness) { mat.metallicTexture = mk(set.roughness); mat.useRoughnessFromMetallicTextureGreen = true; }
      if (set.ao) mat.ambientTexture = mk(set.ao);
    }
    return true;
  } catch {
    return false; // never let a missing/broken asset break the render path
  }
}

// ── Environment ────────────────────────────────────────────────────────────────

// Swap in a real prefiltered .env if one is configured. Returns true if applied.
// world.js calls this after building its procedural sky-probe IBL, so a real env
// simply wins when present.
export function applyEnvIfPresent(scene) {
  if (!ENV_URL || !scene) return false;
  try {
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENV_URL, scene);
    return true;
  } catch {
    return false;
  }
}

// ── Models ───────────────────────────────────────────────────────────────────

// Load a GLB/glTF by logical key. Returns a loaded AssetContainer (caller decides
// addAllToScene / instantiateModelsToScene) or null if the key is absent or load
// fails. The glTF loader is imported on demand so it only ships when used.
export async function loadModel(key, scene) {
  const url = MODELS[key];
  if (!url || !scene) return null;
  try {
    await import("@babylonjs/loaders/glTF"); // register glTF loader (code-split)
    const { LoadAssetContainerAsync } = await import("@babylonjs/core/Loading/sceneLoader");
    return await LoadAssetContainerAsync(url, scene);
  } catch {
    return null;
  }
}

export function hasModel(key) { return !!MODELS[key]; }
export function hasTextureSet(key) { return !!TEX[key]; }
