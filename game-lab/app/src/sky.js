// sky.js — photoreal sky backdrop. Swaps the procedural gradient dome + sun/moon/stars for a
// real CC0 sky HDRI rendered as a skybox. Additive: it disables the world's procedural sky
// meshes by name (no world.js surgery) and does NOT touch scene.environmentTexture (world.js
// owns IBL via its real-time probe). Fallback-safe: if the .hdr is missing the procedural sky
// stays. The day-night lighting tick still runs (sun dir / fog), so lighting still shifts under
// a static sky — acceptable; revisit if the mismatch reads wrong.

import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";

const PROC_SKY_MESHES = ["world_skydome", "world_sun_disc", "world_moon_disc", "world_stars"];

export function createSky(ctx) {
  const { scene } = ctx;
  let hdr;
  try {
    hdr = new HDRCubeTexture("/models/sky.hdr", scene, 1024);
  } catch (e) {
    console.error("photoreal sky load failed — keeping procedural dome", e);
    return;
  }

  // Visible skybox only. pbr=false, blur=0, setGlobalEnvTexture=FALSE → don't fight world's IBL.
  const skybox = scene.createDefaultSkybox(hdr, false, 2200, 0, false);
  if (skybox) { skybox.infiniteDistance = true; skybox.applyFog = false; skybox.isPickable = false; }

  // Retire the procedural sky so there's no double-sky. Disable once now and once after the
  // first frames (world.js may (re)build/enable them during init).
  const hideProcedural = () => {
    for (const name of PROC_SKY_MESHES) scene.getMeshByName(name)?.setEnabled(false);
  };
  hideProcedural();
  let frames = 0;
  const stop = ctx.onFrame(() => { hideProcedural(); if (++frames > 5) stop(); });
}
