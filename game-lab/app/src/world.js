// world.js — Renewal Rush · Phase 4 · the bright real CITY you fight to keep.
//
// createWorld(ctx) builds a sunny, high-definition city block grid that tells the
// Quivly story: you run the product flow — Connect → See → Score → Act — straight
// down a wide central BOULEVARD, flanked by ACCOUNT HQ towers standing on real city
// blocks. The ground is a proper city map: dark asphalt ROADS in a grid, lighter
// concrete SIDEWALK blocks raised at the curb, painted lane lines + zebra crosswalks
// at every intersection, PARK blocks (grass, trees, benches, paths) and PLAZA blocks
// (pavers, planters, radar) for variety. Every tower is a customer account: SIZED by
// tier (strategic skyscraper → self-serve shack), COLOURED by health bucket (Critical
// red / High orange / Medium amber / Healthy green) via a facade tint, a ground-floor
// health band AND a rooftop status beacon whose size tracks ARR — readable at a glance
// from any angle. A grim CHURNED wasteland sits beyond the finish — the place you keep
// accounts out of — with the clean brand-indigo Renewal Gate (the 90s deadline) spanning
// the boulevard at the finish line.
//
// The whole city is ENCLOSED: a tall facade-skin perimeter wall rings the play area and a
// hard per-frame position clamp (BOUNDS, exposed as api.worldBounds) keeps the player
// inside — you can never run off the map into the void.
//
// Look: bright sunny daylight, clean blue sky, only a LIGHT depth haze (you see clear
// across the city). Dark asphalt against light sidewalk restores real contrast — NOT
// washed out, NOT techno-sci-fi. Emissive/glow is reserved for what should glow:
// health beacons, the gate, and radar; fx.js owns the GlowLayer + bloom that pick them up.
//
// Contract: one factory export, deep ESM imports only, all behaviour inside the factory,
// per-frame work via ctx.onFrame, graceful degradation if collaborators are absent.
// api = { update, dispose, sectorAt, worldBounds } (+ optional shadow affordances + gate).

import { Scene } from "@babylonjs/core/scene";
import { Vector3, Vector4, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh"; // for Mesh.DOUBLESIDE (un-mirrored signs)
import "@babylonjs/core/Meshes/thinInstanceMesh"; // side-effect: enables mesh.thinInstanceSetBuffer
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe"; // IBL: capture the live sky into an env cube
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate"; // static colliders (only used when ctx.useHavok)
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { applyTextureSet, applyEnvIfPresent } from "./assets.js"; // optional real-art overrides (procedural is the fallback)
import { ACCOUNTS, accountFor } from "./accounts.js";
import { RENEWAL_MS } from "./game.js"; // day-night cycle is driven by the renewal clock

// Parody tech-account roster grouped by tier (HBO "Silicon Valley" title-sequence vibe:
// a legally-distinct SF skyline). Each building wears its account's wordmark in the
// account accent colour; the health bucket still drives facade tint + rooftop beacon.
const ACCT_BY_TIER = {};
for (const a of ACCOUNTS) (ACCT_BY_TIER[a.tier] || (ACCT_BY_TIER[a.tier] = [])).push(a);

// ── Layout constants ─────────────────────────────────────────────────────────
const SECTOR_LEN = 90;                       // world units per product-flow sector
const SECTORS = 4;                           // Connect · See · Score · Act
const TRACK_LEN = SECTOR_LEN * SECTORS;      // 360 — player travels +Z through this

const ROAD_HW = 6;                           // half-width of a normal cross/side street
const BLVD_HW = 16;                          // half-width of the central play boulevard
// Vertical (N–S) roads, by centre x. The boulevard at x=0 is wide; the rest are streets.
const V_ROADS = [
  { cx: -140, hw: ROAD_HW },
  { cx: -70,  hw: ROAD_HW },
  { cx: 0,    hw: BLVD_HW },
  { cx: 70,   hw: ROAD_HW },
  { cx: 140,  hw: ROAD_HW },
];
// Horizontal (E–W) cross-street centres (each hw = ROAD_HW). 8 blocks deep over 0..360.
const H_ROADS = [-6, 42, 90, 138, 186, 234, 282, 330, 378];

const GATE_Z = 386;                          // Renewal Gate spans the boulevard at the finish
const LOOM_RANGE = 220;                      // distance over which the gate dramatises scale

// Bounded play area — single source of truth used three ways: the clamp, worldBounds,
// and to size the enclosing perimeter wall (which sits just outside these).
const BOUNDS = { minX: -148, maxX: 148, minZ: -8, maxZ: GATE_Z - 4 };
const WALL_X = 156, WALL_Z0 = -20, WALL_Z1 = 478; // perimeter wall rectangle

// Tile sizes (world units per texture repeat) — drive consistent, crisp ground detail.
const TILE_ASPHALT = 12;
const TILE_SIDEWALK = 4;
const TILE_PAVER = 3;
const TILE_GRASS = 6;

// Quivly brand.
const INDIGO = "#6366F1";
const INDIGO_LT = "#818CF8";

// Per-sector identity = the real product flow. Fog stays a constant clean sky-blue (no
// per-sector wash); each sector's ACCENT drives radar rings, streetlight glass, signs and
// gate-adjacent glow, and its name/subtitle surface Quivly vocabulary at each boundary
// (bus "zone" carries the name to HUD/audio).
const PAL = [
  { name: "Connect", sub: "INTEGRATIONS",         accent: INDIGO },
  { name: "See",     sub: "CUSTOMER 360 · RADAR", accent: "#22D3EE" },
  { name: "Score",   sub: "HEALTH SCORE",         accent: "#F59E0B" },
  { name: "Act",     sub: "ACTIONS · AGENTS",     accent: "#22C55E" },
];

// Health buckets — colour by SCORE bucket (per QUIVLY-GROUNDING; never by the risk word).
// Index 0..3 = most at-risk → healthiest.
const BUCKETS = [
  { name: "Critical", hex: "#ef4444" }, // 0–24  : red
  { name: "High",     hex: "#f97316" }, // 25–49 : orange
  { name: "Medium",   hex: "#eab308" }, // 50–74 : amber
  { name: "Healthy",  hex: "#22c55e" }, // 75–100: green
];

// Account tiers → building footprint + height range + representative ARR.
// strategic skyscraper → high_touch → mid → low → self_serve shack.
const TIERS = [
  { name: "strategic",  w: [12, 15], d: [11, 14], h: [44, 64], arr: 460_000 },
  { name: "high_touch", w: [9, 11],  d: [9, 11],  h: [28, 38], arr: 140_000 },
  { name: "mid",        w: [8, 9],   d: [8, 9],   h: [18, 26], arr: 48_000 },
  { name: "low",        w: [7, 8],   d: [7, 8],   h: [11, 16], arr: 18_000 },
  { name: "self_serve", w: [6, 7],   d: [6, 7],   h: [6, 9],   arr: 5_000 },
];

// Per-sector account mix: weights over [Critical, High, Medium, Healthy] and a tier bias.
// Connect is calm + healthy; Score/Act are where the high-stakes red whales live.
const SECTOR_MIX = [
  { buckets: [0.04, 0.10, 0.36, 0.50], tierBias: [0.06, 0.16, 0.30, 0.30, 0.18] }, // Connect
  { buckets: [0.10, 0.24, 0.40, 0.26], tierBias: [0.10, 0.22, 0.32, 0.24, 0.12] }, // See
  { buckets: [0.30, 0.40, 0.24, 0.06], tierBias: [0.18, 0.26, 0.30, 0.18, 0.08] }, // Score
  { buckets: [0.46, 0.34, 0.16, 0.04], tierBias: [0.26, 0.28, 0.26, 0.14, 0.06] }, // Act
];
const BACK_TIER_BIAS = [0.34, 0.34, 0.20, 0.10, 0.02]; // back-row columns skew tall (skyline)

const FLOOR_H = 3.4;   // world units per window row (consistent across all tiers)
const COL_W = 3.2;     // world units per window column

export function createWorld(ctx) {
  const { engine, scene, camera, bus, state, game } = ctx || {};
  if (!scene) {
    return {
      update() {}, dispose() {},
      sectorAt: () => ({ index: 0, name: PAL[0].name, progress: 0, accent: Color3.FromHexString(PAL[0].accent) }),
      worldBounds: { ...BOUNDS },
      timeOfDay: () => ({ progress: 0, night: 0, phase: "day" }),
    };
  }

  // Pre-resolve palette + bucket colours once (no per-frame allocation).
  for (const p of PAL) p.accC = Color3.FromHexString(p.accent);
  for (const b of BUCKETS) b.c = Color3.FromHexString(b.hex);
  const WHITE = new Color3(1, 1, 1);
  const CONCRETE = new Color3(0.84, 0.86, 0.90); // light facade base; albedo tints from here

  // Double-sided wordmark UVs: the FRONT reads left-to-right; the BACK face's winding is
  // reversed by Babylon, so we flip its U (1→0) to cancel the mirror. With these, a sign
  // reads upright on BOTH the +X and −X side of the boulevard (no reversed text). Paired
  // with backFaceCulling=TRUE on the shared sign material so the two coincident facets
  // don't double-blend (see signMaterialFor).
  const SIGN_FRONT_UV = new Vector4(0, 0, 1, 1);
  const SIGN_BACK_UV = new Vector4(1, 0, 0, 1);

  // Disposal bookkeeping — everything we create gets torn down cleanly.
  const meshes = [];
  const mats = [];
  const texes = [];
  const signMatCache = new Map(); // account name → shared wordmark material (reused per tier)
  const track = (arr, x) => { arr.push(x); return x; };

  // Deterministic jitter, SEEDED FROM THE DAILY SEED → the same daily run lays out the
  // same city + skyline every time. This is its own LCG stream (NOT game.rng), so it
  // never perturbs the enemy spawn stream's daily-seed determinism.
  const dailySeed = (game && game.seed != null) ? (game.seed >>> 0) : 0;
  let seed = ((0x9e3779b1 ^ dailySeed) & 0x7fffffff) || 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
  const rand = (a, b) => a + (b - a) * rnd();
  const ri = (a, b) => (a + Math.floor(rnd() * (b - a + 1)));
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const wpick = (weights) => {
    let sum = 0; for (const w of weights) sum += w;
    let r = rnd() * sum;
    for (let i = 0; i < weights.length; i++) { if ((r -= weights[i]) < 0) return i; }
    return weights.length - 1;
  };

  const isOn = (f) => (typeof f === "function" ? !!f() : !!f);
  const isRunning = () => isOn(state?.running);
  const isPaused = () => isOn(state?.paused);

  let clampObserver = null; // boundary clamp observer (removed on dispose)

  // ── Atmosphere: ONLY a light depth haze. Distance stays sharp; you see clear across
  //    the city. Fog colour is a clean, saturated sky-blue matched to the sky horizon —
  //    reads as aerial depth, never a white-out. ────────────────────────────────────
  const FOG = Color3.FromHexString("#a4c6ec");
  scene.fogEnabled = true;
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = FOG.clone();
  scene.fogDensity = 0.00060;                 // well below the old 0.0007–0.0009 — you can see across
  scene.ambientColor = new Color3(0.58, 0.64, 0.72);
  scene.clearColor = new Color4(0.66, 0.80, 0.95, 1); // bright sky (before dome renders)

  if (camera) {
    camera.maxZ = Math.max(camera.maxZ || 0, 2600);
    if (!camera.minZ || camera.minZ > 0.4) camera.minZ = 0.25;
    // Boundary clamp — the #1 fix. Runs on onBeforeRender → AFTER the controller has moved
    // the camera this frame, BEFORE render. Keeps the player inside the walled city.
    const { minX, maxX, minZ, maxZ } = BOUNDS;
    clampObserver = scene.onBeforeRenderObservable.add(() => {
      const p = camera.position;
      if (p.x < minX) p.x = minX; else if (p.x > maxX) p.x = maxX;
      if (p.z < minZ) p.z = minZ; else if (p.z > maxZ) p.z = maxZ;
    });
  }

  // ── Lighting + shadows: strong warm sun + clean sky fill (neutral city bounce). ──
  const hemi = new HemisphericLight("world_hemi", new Vector3(0.12, 1, 0.06), scene);
  hemi.intensity = 0.85;
  hemi.diffuse = new Color3(0.92, 0.95, 1.0);        // cool sky fill
  hemi.groundColor = new Color3(0.36, 0.37, 0.40);   // grey city bounce (not green)
  hemi.specular = new Color3(0.2, 0.2, 0.22);

  const sun = new DirectionalLight("world_sun", new Vector3(-0.42, -1, 0.34), scene);
  sun.position = new Vector3(90, 180, -70);
  sun.intensity = 2.25;
  sun.diffuse = new Color3(1.0, 0.97, 0.9);          // warm sunlight
  sun.specular = new Color3(1.0, 0.98, 0.92);

  // Cascaded shadow maps: 4 cascades sized to the camera frustum beat one 2048 map
  // stretched over a 360-unit outdoor scene — crisp shadows underfoot AND out to the
  // skyline, instead of soft mush everywhere. Drop-in: addShadowCaster is inherited.
  const shadowGen = new CascadedShadowGenerator(1024, sun);
  shadowGen.numCascades = 4;
  shadowGen.lambda = 0.85;              // bias cascade splits toward the camera (sharp near shadows)
  shadowGen.cascadeBlendPercentage = 0.04; // hide cascade seams
  shadowGen.stabilizeCascades = true;  // kill edge shimmer as the sun arcs through the day/night cycle
  shadowGen.shadowMaxZ = 520;          // cover visible city depth; beyond this, no shadow (cheap)
  shadowGen.depthClamp = true;
  shadowGen.filter = ShadowGenerator.FILTER_PCF;        // smooth, reliable (PCSS can fizzle on thin geo)
  shadowGen.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadowGen.bias = 0.012;
  shadowGen.normalBias = 0.02;
  if (typeof shadowGen.setDarkness === "function") shadowGen.setDarkness(0.34);

  // ── Texture helpers (sharp: mipmaps + trilinear + anisotropy on every tiled map) ──
  const sharpen = (tex, aniso = 16) => { try { tex.anisotropicFilteringLevel = aniso; } catch { /* noop */ } return tex; };
  const wrapTiled = (tex, aniso = 16) => { tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE; return sharpen(tex, aniso); };

  // Derive a tangent-space normal map from a drawn texture's luminance (bright ≈ high).
  // Cheap one-time CPU Sobel at load. Gives the flat procedural surfaces real micro-relief
  // (asphalt grain, sidewalk/paver seams, window mullions) so the new IBL/SSR/shadows have
  // surface detail to react to — a genuine "flat → real" step with zero art assets. The
  // authored-normal path in assets.js overrides this when a real map is supplied.
  // strength = bump amount; verify-tunable (flip mat.invertNormalMapY if relief reads inverted).
  const deriveNormalMap = (srcTex, name, strength = 2.0) => {
    try {
      const { width: W, height: H } = srcTex.getSize();
      const src = srcTex.getContext().getImageData(0, 0, W, H).data;
      const L = (x, y) => { x = (x % W + W) % W; y = (y % H + H) % H; const i = (y * W + x) << 2; return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255; };
      const out = track(texes, new DynamicTexture(name, { width: W, height: H }, scene, true));
      const octx = out.getContext(); const img = octx.createImageData(W, H); const o = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (L(x - 1, y) - L(x + 1, y)) * strength;
        const dy = (L(x, y - 1) - L(x, y + 1)) * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * W + x) << 2;
        o[i] = (dx * inv * 0.5 + 0.5) * 255; o[i + 1] = (dy * inv * 0.5 + 0.5) * 255; o[i + 2] = (inv * 0.5 + 0.5) * 255; o[i + 3] = 255;
      }
      octx.putImageData(img, 0, 0); out.update(false);
      out.wrapU = Texture.WRAP_ADDRESSMODE; out.wrapV = Texture.WRAP_ADDRESSMODE; sharpen(out, 8);
      return out;
    } catch { return null; }
  };

  // Asphalt road surface — dark, with fine aggregate + faint patch variation. Tiled, crisp.
  const asphaltTex = track(texes, new DynamicTexture("world_asphalt", { width: 512, height: 512 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 512, c = asphaltTex.getContext();
    c.fillStyle = "#2b2e33"; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 80; i++) {            // broad tonal patches
      c.globalAlpha = 0.08;
      c.fillStyle = Math.random() > 0.5 ? "#34373d" : "#232529";
      const r = 20 + Math.random() * 70;
      c.beginPath(); c.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    for (let i = 0; i < 9000; i++) {          // aggregate speckle (fine grain)
      const v = Math.random();
      c.fillStyle = v > 0.7 ? "#3b3e44" : v > 0.4 ? "#26282c" : "#43464c";
      const s = 0.6 + Math.random() * 1.6;
      c.fillRect(Math.random() * S, Math.random() * S, s, s);
    }
    asphaltTex.update();
    wrapTiled(asphaltTex, 16);
  }

  // Sidewalk / building-lot concrete — light grey paving with panel seams. High contrast vs asphalt.
  const sidewalkTex = track(texes, new DynamicTexture("world_sidewalk", { width: 512, height: 512 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 512, c = sidewalkTex.getContext();
    c.fillStyle = "#b9bcc2"; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 1600; i++) {          // subtle speckle
      c.globalAlpha = 0.06; c.fillStyle = Math.random() > 0.5 ? "#cdd0d6" : "#a4a7ad";
      c.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4);
    }
    c.globalAlpha = 1;
    c.strokeStyle = "#9a9da3"; c.lineWidth = 2;  // paving slab seams (4×4 panels per tile)
    const n = 4, step = S / n;
    for (let i = 0; i <= n; i++) {
      c.beginPath(); c.moveTo(i * step, 0); c.lineTo(i * step, S); c.stroke();
      c.beginPath(); c.moveTo(0, i * step); c.lineTo(S, i * step); c.stroke();
    }
    sidewalkTex.update();
    wrapTiled(sidewalkTex, 16);
  }

  // Plaza pavers — warm tan herringbone-ish grid for variety underfoot.
  const paverTex = track(texes, new DynamicTexture("world_paver", { width: 512, height: 512 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 512, c = paverTex.getContext();
    c.fillStyle = "#c2a883"; c.fillRect(0, 0, S, S);
    const n = 6, step = S / n;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const off = (gy % 2) * (step / 2);
        c.fillStyle = (gx + gy) % 2 ? "#bb9f78" : "#cbb189";
        c.fillRect(gx * step + off, gy * step + 2, step - 3, step - 3);
      }
    }
    c.strokeStyle = "rgba(120,100,70,0.35)"; c.lineWidth = 2;
    for (let i = 0; i <= n; i++) { c.beginPath(); c.moveTo(i * step, 0); c.lineTo(i * step, S); c.stroke(); }
    paverTex.update();
    wrapTiled(paverTex, 16);
  }

  // Park grass — lush blades over patchy base. Tiled, crisp at grazing angles.
  const grassTex = track(texes, new DynamicTexture("world_grass", { width: 512, height: 512 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 512, g = grassTex.getContext();
    g.fillStyle = "#4f8536"; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 280; i++) {
      g.globalAlpha = 0.16; g.fillStyle = Math.random() > 0.5 ? "#62a046" : "#3d6c28";
      g.beginPath(); g.arc(Math.random() * S, Math.random() * S, 10 + Math.random() * 48, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1; g.lineCap = "round";
    for (let i = 0; i < 6000; i++) {
      const x = Math.random() * S, y = Math.random() * S, sh = Math.random();
      g.strokeStyle = sh > 0.7 ? "#79bb55" : sh > 0.4 ? "#3d6c28" : "#5b9a3c";
      g.lineWidth = 0.8 + Math.random() * 1.4;
      const len = 3 + Math.random() * 7, ang = -Math.PI / 2 + (Math.random() - 0.5) * 0.8;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); g.stroke();
    }
    grassTex.update();
    wrapTiled(grassTex, 16);
  }

  // Cracked dead earth — the churned wasteland floor.
  const deadTex = track(texes, new DynamicTexture("world_dead", { width: 512, height: 512 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 512, c = deadTex.getContext();
    c.fillStyle = "#221d18"; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 60; i++) { c.globalAlpha = 0.1; c.fillStyle = Math.random() > 0.5 ? "#2c241c" : "#191410"; c.beginPath(); c.arc(Math.random() * S, Math.random() * S, 20 + Math.random() * 60, 0, Math.PI * 2); c.fill(); }
    c.globalAlpha = 0.5; c.strokeStyle = "#120e0a"; c.lineWidth = 2; // cracks
    for (let i = 0; i < 40; i++) {
      let x = Math.random() * S, y = Math.random() * S; c.beginPath(); c.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (Math.random() - 0.5) * 70; y += (Math.random() - 0.5) * 70; c.lineTo(x, y); }
      c.stroke();
    }
    deadTex.update();
    wrapTiled(deadTex, 8);
  }

  // Crisp daylight sky gradient — deep zenith, saturated horizon (no white wash).
  const skyTex = track(texes, new DynamicTexture("world_sky", { width: 8, height: 256 }, scene, false));
  {
    const c = skyTex.getContext();
    const grad = c.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.00, "#1f5fc4"); // zenith — deep clean blue
    grad.addColorStop(0.45, "#3f86df");
    grad.addColorStop(0.68, "#6aa8ea");
    grad.addColorStop(0.84, "#93c0ea"); // horizon glow (saturated, not white)
    grad.addColorStop(1.00, "#a4c6ec"); // matches fog colour exactly
    c.fillStyle = grad; c.fillRect(0, 0, 8, 256);
    skyTex.update();
  }

  // Soft round dot for drifting dust motes.
  const dotTex = track(texes, new DynamicTexture("world_mote", { width: 64, height: 64 }, scene, true));
  {
    const c = dotTex.getContext();
    const rg = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0.0, "rgba(255,255,250,1)");
    rg.addColorStop(0.4, "rgba(255,251,235,0.5)");
    rg.addColorStop(1.0, "rgba(255,248,225,0)");
    c.fillStyle = rg; c.fillRect(0, 0, 64, 64);
    dotTex.update(); dotTex.hasAlpha = true;
  }

  // Window-facade cell (one window in a wall border → tiles into a clean grid via faceUV).
  const facadeTex = track(texes, new DynamicTexture("world_facade", { width: 128, height: 128 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE));
  {
    const S = 128, c = facadeTex.getContext();
    c.fillStyle = "#e7eaef"; c.fillRect(0, 0, S, S);
    const wg = c.createLinearGradient(0, 0, 0, S);
    wg.addColorStop(0, "rgba(255,255,255,0.10)"); wg.addColorStop(1, "rgba(120,130,150,0.12)");
    c.fillStyle = wg; c.fillRect(0, 0, S, S);
    const m = 16, ww = S - m * 2, wh = S - m * 2;
    const gg = c.createLinearGradient(m, m, m, m + wh);
    gg.addColorStop(0.0, "#bcd2e8"); gg.addColorStop(0.5, "#8fb0cf"); gg.addColorStop(1.0, "#6f93b4");
    c.fillStyle = gg; c.fillRect(m, m, ww, wh);
    c.strokeStyle = "#56657a"; c.lineWidth = 4; c.strokeRect(m, m, ww, wh);
    c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(S / 2, m); c.lineTo(S / 2, m + wh); c.stroke();
    c.beginPath(); c.moveTo(m, S / 2); c.lineTo(m + ww, S / 2); c.stroke();
    c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(m + 6, m + wh * 0.7); c.lineTo(m + ww * 0.6, m + 6); c.stroke();
    facadeTex.update();
    wrapTiled(facadeTex, 8);
  }

  // Quivly Radar ground-ring texture (white on transparent → emissive tints to accent).
  const radarTex = track(texes, new DynamicTexture("world_radar", { width: 256, height: 256 }, scene, true));
  {
    const S = 256, cx = S / 2, cy = S / 2, c = radarTex.getContext();
    c.clearRect(0, 0, S, S);
    c.strokeStyle = "rgba(255,255,255,0.9)";
    for (let k = 0; k < 3; k++) { c.lineWidth = k === 2 ? 5 : 3; c.globalAlpha = 0.55 + k * 0.18; c.beginPath(); c.arc(cx, cy, 36 + k * 40, 0, Math.PI * 2); c.stroke(); }
    c.globalAlpha = 0.4; c.lineWidth = 2;
    for (let a = 0; a < 12; a++) { const t = (a / 12) * Math.PI * 2; c.beginPath(); c.moveTo(cx + Math.cos(t) * 36, cy + Math.sin(t) * 36); c.lineTo(cx + Math.cos(t) * 118, cy + Math.sin(t) * 118); c.stroke(); }
    c.globalAlpha = 1; c.fillStyle = "rgba(255,255,255,1)"; c.beginPath(); c.arc(cx, cy, 6, 0, Math.PI * 2); c.fill();
    radarTex.update(); radarTex.hasAlpha = true; sharpen(radarTex, 4);
  }

  // ── Helper: flat emissive material (reads as pure light, GlowLayer-friendly). ──
  const neon = (name, color3, intensity = 1) => {
    const m = track(mats, new StandardMaterial(name, scene));
    m.disableLighting = true;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.emissiveColor = color3.scale(intensity);
    return m;
  };

  // ── Night neon registry. Each registered material's emissive is, per frame, set to
  //    base * (1 + nightAmt * boost): identical to today at DAY (nightAmt 0 → ×1), and
  //    glows brighter toward NIGHT so the city stays vivid + readable in the dark (the
  //    GlowLayer/bloom in fx.js picks it up → Total-Overdose neon). Base colours are
  //    captured once; the per-frame cost is one scaleToRef each (no allocation). The
  //    already-animated emissives (crit beacon, radar rings, gate core) fold the same
  //    factor into their existing per-frame line instead of registering here. ─────────
  const glowMats = [];
  const regGlow = (mat, boost) => {
    if (mat && mat.emissiveColor) glowMats.push({ mat, base: mat.emissiveColor.clone(), boost });
    return mat;
  };

  // ── Base asphalt ground: wide plane under the whole city (the road network shows
  //    through wherever a block slab isn't laid on top). ─────────────────────────
  const groundW = (WALL_X + 20) * 2;
  const groundD = (WALL_Z1 - WALL_Z0) + 40;
  const groundCZ = (WALL_Z0 + WALL_Z1) / 2;
  const ground = track(meshes, MeshBuilder.CreateGround("world_ground", { width: groundW, height: groundD, subdivisions: 1 }, scene));
  ground.position.set(0, 0, groundCZ);
  ground.receiveShadows = true; ground.isPickable = false;
  const gMat = track(mats, new PBRMaterial("world_ground_mat", scene));
  gMat.albedoColor = new Color3(1, 1, 1);
  gMat.albedoTexture = asphaltTex;
  gMat.metallic = 0.0; gMat.roughness = 0.55; gMat.environmentIntensity = 0.7; // wet-asphalt sheen → catches IBL + SSR
  asphaltTex.uScale = groundW / TILE_ASPHALT;
  asphaltTex.vScale = groundD / TILE_ASPHALT;
  const gN = deriveNormalMap(asphaltTex, "world_asphalt_n", 1.6); // aggregate micro-relief
  if (gN) { gN.uScale = asphaltTex.uScale; gN.vScale = asphaltTex.vScale; gMat.bumpTexture = gN; gMat.bumpTexture.level = 0.55; }
  applyTextureSet(gMat, "asphalt", scene, { uScale: asphaltTex.uScale, vScale: asphaltTex.vScale }); // real road art overrides the derived normal
  ground.material = gMat;

  // Shared slab materials (one each → consistent tiling via per-mesh faceUV, not per-mat).
  const mkSlabMat = (name, tex, assetKey) => {
    const m = track(mats, new PBRMaterial(name, scene));
    m.albedoColor = new Color3(1, 1, 1); m.albedoTexture = tex;
    m.metallic = 0.0; m.roughness = 0.7; m.environmentIntensity = 0.5; // damp concrete → soft IBL sheen
    const n = deriveNormalMap(tex, name + "_n", 1.8); // seam/grout relief
    if (n) { m.bumpTexture = n; m.bumpTexture.level = 0.5; }
    if (assetKey) applyTextureSet(m, assetKey, scene); // real paving art overrides
    return m;
  };
  const sidewalkMat = mkSlabMat("world_sidewalk_mat", sidewalkTex, "sidewalk");
  const paverMat = mkSlabMat("world_paver_mat", paverTex, "paver");
  const grassMat = mkSlabMat("world_grass_mat", grassTex);
  grassMat.roughness = 1.0; grassMat.environmentIntensity = 0.3; // grass stays matte

  // Lay a flat city-block slab (raised at the curb) with consistently tiled top texture.
  const makeSlab = (cx, cz, w, d, mat, tile, name) => {
    const top = new Vector4(0, 0, w / tile, d / tile);
    const side = new Vector4(0, 0, 1, 0.2);
    // Set BOTH horizontal faces (4 & 5) to the tiled UV — whichever is the visible top
    // gets consistent paving regardless of the box's face-index convention.
    const faceUV = [side, side, side, side, top, top];
    const s = track(meshes, MeshBuilder.CreateBox(name, { width: w, height: 0.2, depth: d, wrap: true, faceUV }, scene));
    s.position.set(cx, 0.1, cz);
    s.material = mat; s.isPickable = false; s.receiveShadows = true;
    return s;
  };

  // ── Horizon sky dome (follows camera, sharp gradient). ───────────────────────
  const sky = track(meshes, MeshBuilder.CreateSphere("world_skydome", { diameter: 2000, segments: 24 }, scene));
  sky.infiniteDistance = true; sky.applyFog = false; sky.isPickable = false;
  const sMat = track(mats, new StandardMaterial("world_sky_mat", scene));
  sMat.backFaceCulling = false; sMat.disableLighting = true;
  sMat.diffuseColor = new Color3(0, 0, 0); sMat.specularColor = new Color3(0, 0, 0);
  sMat.emissiveColor = new Color3(1, 1, 1); sMat.emissiveTexture = skyTex;
  sky.material = sMat;

  // ── Celestial bodies: SUN DISC + MOON + STAR FIELD ───────────────────────────
  // All pinned to the sky via infiniteDistance (their translation rides the camera →
  // a fixed sky DIRECTION) and billboarded so the discs always face the player. The
  // day-night cycle (see tick) repositions, recolours, and fades them each frame.
  // Distances nest INSIDE the 1000-radius dome (sun/moon 700 < stars 850 < dome 1000)
  // so transparent sort order is correct and there's no z-fight; buildings (near +
  // opaque) still occlude them, which reads as the sun/moon passing behind a tower.
  const SKY_DIST = 700;

  // Soft sun / flare disc — bright core → warm halo → transparent (tinted per frame).
  const sunTex = track(texes, new DynamicTexture("world_sun", { width: 256, height: 256 }, scene, true));
  {
    const S = 256, cc = S / 2, c = sunTex.getContext();
    c.clearRect(0, 0, S, S);
    const rg = c.createRadialGradient(cc, cc, 0, cc, cc, cc);
    rg.addColorStop(0.00, "rgba(255,255,255,1)");
    rg.addColorStop(0.14, "rgba(255,250,236,0.97)");
    rg.addColorStop(0.36, "rgba(255,226,182,0.55)");
    rg.addColorStop(0.70, "rgba(255,200,150,0.14)");
    rg.addColorStop(1.00, "rgba(255,190,140,0)");
    c.fillStyle = rg; c.fillRect(0, 0, S, S);
    sunTex.update(); sunTex.hasAlpha = true;
  }
  const sunMat = track(mats, new StandardMaterial("world_sun_mat", scene));
  sunMat.disableLighting = true; sunMat.backFaceCulling = false;
  sunMat.diffuseColor = new Color3(0, 0, 0); sunMat.specularColor = new Color3(0, 0, 0);
  sunMat.emissiveColor = new Color3(1, 0.97, 0.86); sunMat.emissiveTexture = sunTex; sunMat.opacityTexture = sunTex;
  const sunDisc = track(meshes, MeshBuilder.CreatePlane("world_sun_disc", { size: 130 }, scene));
  sunDisc.material = sunMat; sunDisc.infiniteDistance = true; sunDisc.billboardMode = Mesh.BILLBOARDMODE_ALL;
  sunDisc.applyFog = false; sunDisc.isPickable = false; sunDisc.receiveShadows = false;

  // Moon — cool disc with soft maria + faint halo; fades in at night.
  const moonTex = track(texes, new DynamicTexture("world_moon", { width: 256, height: 256 }, scene, true));
  {
    const S = 256, cc = S / 2, c = moonTex.getContext();
    c.clearRect(0, 0, S, S);
    const halo = c.createRadialGradient(cc, cc, 0, cc, cc, cc);
    halo.addColorStop(0.00, "rgba(214,226,255,0.5)");
    halo.addColorStop(0.42, "rgba(200,214,255,0.15)");
    halo.addColorStop(1.00, "rgba(200,214,255,0)");
    c.fillStyle = halo; c.fillRect(0, 0, S, S);
    const r = S * 0.32;
    const body = c.createRadialGradient(cc - r * 0.3, cc - r * 0.3, r * 0.2, cc, cc, r);
    body.addColorStop(0.0, "rgba(248,250,255,1)");
    body.addColorStop(1.0, "rgba(206,220,246,1)");
    c.fillStyle = body; c.beginPath(); c.arc(cc, cc, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = "rgba(184,200,232,0.5)";
    for (const m of [[-0.28, -0.18, 0.16], [0.22, 0.1, 0.12], [-0.05, 0.3, 0.1]]) {
      c.beginPath(); c.arc(cc + m[0] * r * 2, cc + m[1] * r * 2, m[2] * r * 2, 0, Math.PI * 2); c.fill();
    }
    moonTex.update(); moonTex.hasAlpha = true;
  }
  const moonMat = track(mats, new StandardMaterial("world_moon_mat", scene));
  moonMat.disableLighting = true; moonMat.backFaceCulling = false;
  moonMat.diffuseColor = new Color3(0, 0, 0); moonMat.specularColor = new Color3(0, 0, 0);
  moonMat.emissiveColor = new Color3(0.86, 0.9, 1.0); moonMat.emissiveTexture = moonTex; moonMat.opacityTexture = moonTex;
  moonMat.alpha = 0; // hidden by day
  const moonDisc = track(meshes, MeshBuilder.CreatePlane("world_moon_disc", { size: 95 }, scene));
  moonDisc.material = moonMat; moonDisc.infiniteDistance = true; moonDisc.billboardMode = Mesh.BILLBOARDMODE_ALL;
  moonDisc.applyFog = false; moonDisc.isPickable = false; moonDisc.receiveShadows = false;

  // Star field — random points on an inner dome (camera is INSIDE → backFaceCulling off).
  // Fades in at night via material alpha. Cheap: one sphere, one texture, zero per-frame work.
  const starTex = track(texes, new DynamicTexture("world_stars", { width: 1024, height: 1024 }, scene, true));
  {
    const S = 1024, c = starTex.getContext();
    c.clearRect(0, 0, S, S);
    for (let i = 0; i < 1300; i++) {
      const x = Math.random() * S, y = Math.random() * S, b = Math.random();
      const r = b > 0.965 ? 2.4 : b > 0.8 ? 1.5 : 0.9;
      c.globalAlpha = 0.35 + b * 0.65;
      c.fillStyle = b > 0.92 ? "#cfe0ff" : b > 0.7 ? "#ffffff" : "#fff4e0";
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1; starTex.update(); starTex.hasAlpha = true;
  }
  const starMat = track(mats, new StandardMaterial("world_stars_mat", scene));
  starMat.disableLighting = true; starMat.backFaceCulling = false;
  starMat.diffuseColor = new Color3(0, 0, 0); starMat.specularColor = new Color3(0, 0, 0);
  starMat.emissiveColor = new Color3(1, 1, 1); starMat.emissiveTexture = starTex; starMat.opacityTexture = starTex;
  starMat.alpha = 0; // hidden by day
  const starDome = track(meshes, MeshBuilder.CreateSphere("world_stardome", { diameter: 1700, segments: 20 }, scene));
  starDome.material = starMat; starDome.infiniteDistance = true; starDome.applyFog = false;
  starDome.isPickable = false; starDome.receiveShadows = false;

  // ── Image-based lighting: capture the live sky (dome + sun/moon/stars) into a
  //    small env cube and feed it to scene.environmentTexture. This is what gives
  //    PBR surfaces real sky reflections — and because the renderList is only the
  //    celestial meshes (which recolour through the day/night cycle), the env (and
  //    every reflection drawn from it) warms at dusk and cools at night for free.
  //    Tiny renderList + low res + every-other-frame refresh → effectively free. ──
  const iblProbe = new ReflectionProbe("world_ibl", 128, scene);
  iblProbe.renderList.push(sky, sunDisc, moonDisc, starDome);
  iblProbe.cubeTexture.refreshRate = 2; // REFRESHRATE_RENDER_ONEVERYTWOFRAMES
  iblProbe.position.set(0, 24, (WALL_Z0 + WALL_Z1) / 2);
  scene.environmentTexture = iblProbe.cubeTexture;
  // 0.6, not 1.0: the bright daytime sky probe at full strength floods the scene with
  // flat omnidirectional fill that overpowers the 0.55 sun → milky, low-contrast, the
  // opposite of photoreal. Keep IBL as a *subtle* fill so the directional sun + shadows
  // read; reflections on cars/glass still land (they scale with this, but stay visible).
  scene.environmentIntensity = 0.6;
  applyEnvIfPresent(scene); // a real prefiltered .env (assets.js) wins over the procedural probe when present

  // ── Shared building decoration bases (instanced → batched draw calls). ────────
  const footprints = [];      // { x, z, hw, hd } for collision-free prop scatter
  const critBeacons = [];     // critical-account beacons (pulse to draw the eye)

  const capMat = track(mats, new PBRMaterial("world_cap_mat", scene));
  capMat.albedoColor = new Color3(0.28, 0.30, 0.34); capMat.metallic = 0.0; capMat.roughness = 0.7;
  const capBase = track(meshes, MeshBuilder.CreateBox("world_cap_base", { size: 1 }, scene));
  capBase.material = capMat; capBase.isPickable = false; capBase.setEnabled(false);

  const antMat = track(mats, new PBRMaterial("world_ant_mat", scene));
  antMat.albedoColor = new Color3(0.20, 0.22, 0.26); antMat.metallic = 0.0; antMat.roughness = 0.6;
  const antBase = track(meshes, MeshBuilder.CreateCylinder("world_ant_base", { height: 1, diameter: 0.34, tessellation: 5 }, scene));
  antBase.material = antMat; antBase.isPickable = false; antBase.setEnabled(false);

  const acBase = track(meshes, MeshBuilder.CreateBox("world_ac_base", { size: 1 }, scene));
  acBase.material = capMat; acBase.isPickable = false; acBase.setEnabled(false);

  // Shared facade materials — ONE per health bucket (tint + emissive depend only on bucket;
  // window tiling lives in each building's faceUV geometry, so materials reuse safely).
  const facadeMats = [];
  const facadeN = deriveNormalMap(facadeTex, "world_facade_n", 2.2); // window mullion / recess relief (shared across buckets)
  for (let b = 0; b < BUCKETS.length; b++) {
    const mat = track(mats, new PBRMaterial(`world_facade_mat_${b}`, scene));
    mat.albedoTexture = facadeTex;
    const tint = new Color3(); Color3.LerpToRef(CONCRETE, BUCKETS[b].c, 0.34, tint);
    mat.albedoColor = tint;
    mat.metallic = 0.1; mat.roughness = 0.22; mat.environmentIntensity = 0.85; // glass curtain-wall → mirrors the sky + neighbours (SSR)
    mat.emissiveColor = BUCKETS[b].c.scale(0.05); // near-zero: windows read by albedo, not glow
    if (facadeN) { mat.bumpTexture = facadeN; mat.bumpTexture.level = 0.6; }
    applyTextureSet(mat, "facade", scene, { keepAlbedo: true }); // real window relief overrides; keep health tint
    facadeMats.push(mat);
  }

  // Per-bucket beacon + health-band emissive sources (the glow that colour-codes health).
  const beaconBases = [], bandBases = [];
  for (let b = 0; b < BUCKETS.length; b++) {
    const bm = neon(`world_beacon_mat_${b}`, BUCKETS[b].c, 1.3);
    const beacon = track(meshes, MeshBuilder.CreateBox(`world_beacon_base_${b}`, { size: 1 }, scene));
    beacon.material = bm; beacon.isPickable = false; beacon.setEnabled(false); beacon.__mat = bm;
    beaconBases.push(beacon);
    if (b > 0) regGlow(bm, 1.5); // b===0 (Critical) is animated per-frame → boost folded there
    const dm = neon(`world_band_mat_${b}`, BUCKETS[b].c, 0.95);
    const band = track(meshes, MeshBuilder.CreateBox(`world_band_base_${b}`, { size: 1 }, scene));
    band.material = dm; band.isPickable = false; band.setEnabled(false);
    bandBases.push(band);
    regGlow(dm, 1.5); // ground-floor health bands glow brighter at night
  }
  const critBeaconMat = beaconBases[0].__mat;

  // Dead/husk material for the churned wasteland (no glow — these accounts went dark).
  const huskMat = track(mats, new PBRMaterial("world_husk_mat", scene));
  huskMat.albedoColor = new Color3(0.19, 0.18, 0.19); huskMat.metallic = 0.0; huskMat.roughness = 0.95;

  let bldgN = 0;
  const makeBuilding = (x, z, W, D, H, bucketIdx, tierIdx, arr) => {
    bldgN += 1; const id = bldgN;
    const acct = pickAccount(tierIdx); // parody tech account for this slot (tier-matched)

    // Facade UV tiling → consistent window size regardless of building scale.
    const vT = Math.max(2, Math.round(H / FLOOR_H));
    const uW = Math.max(2, Math.round(W / COL_W));
    const uD = Math.max(2, Math.round(D / COL_W));
    const wallUV = new Vector4(0.02, 0.02, 0.05, 0.05);
    const faceUV = [
      new Vector4(0, 0, uW, vT), new Vector4(0, 0, uW, vT),
      new Vector4(0, 0, uD, vT), new Vector4(0, 0, uD, vT),
      wallUV, wallUV,
    ];
    const body = track(meshes, MeshBuilder.CreateBox(`world_hq_${id}`, { width: W, depth: D, height: H, wrap: true, faceUV }, scene));
    body.position.set(x, H / 2, z);
    body.isPickable = false; body.checkCollisions = true; body.receiveShadows = true;
    body.material = facadeMats[bucketIdx];
    shadowGen.addShadowCaster(body);

    // Roof cap.
    const capH = 0.9 + H * 0.012;
    const cap = capBase.createInstance(`world_cap_${id}`);
    cap.scaling.set(W * 1.05, capH, D * 1.05); cap.position.set(x, H + capH / 2, z); cap.isPickable = false;

    // Ground-floor health band on ALL four faces → eye-level colour code from any angle.
    const arrGlow = clamp01((Math.log10(Math.max(1000, arr)) - 3) / 2.7); // 0..1 over ~$1k→$460k
    for (const sgn of [-1, 1]) {
      const bz = bandBases[bucketIdx].createInstance(`world_bandz_${id}_${sgn}`);
      bz.scaling.set(W * 1.02, 1.1, 0.3); bz.position.set(x, 1.0, z + sgn * (D / 2 + 0.05)); bz.isPickable = false;
      const bx = bandBases[bucketIdx].createInstance(`world_bandx_${id}_${sgn}`);
      bx.scaling.set(0.3, 1.1, D * 1.02); bx.position.set(x + sgn * (W / 2 + 0.05), 1.0, z); bx.isPickable = false;
    }

    // Rooftop status beacon — SIZE tracks ARR, colour tracks health, glows via GlowLayer.
    const beaconS = 0.9 + arrGlow * 1.8;
    const beacon = beaconBases[bucketIdx].createInstance(`world_beacon_${id}`);
    beacon.scaling.set(beaconS, beaconS * 1.4, beaconS);
    beacon.position.set(x, H + capH + beaconS * 0.7, z); beacon.isPickable = false;
    if (bucketIdx === 0) critBeacons.push(beacon);

    // Antenna on the bigger accounts; AC units for rooftop realism.
    if (tierIdx <= 1) {
      const antH = 4 + arrGlow * 8;
      const ant = antBase.createInstance(`world_ant_${id}`);
      ant.scaling.set(1, antH, 1); ant.position.set(x + W * 0.2, H + capH + antH / 2, z - D * 0.15); ant.isPickable = false;
    }
    if (tierIdx <= 2) {
      const acn = ri(1, 3);
      for (let i = 0; i < acn; i++) {
        const ac = acBase.createInstance(`world_ac_${id}_${i}`);
        const s = rand(1.0, 2.0);
        ac.scaling.set(s, s * 0.6, s);
        ac.position.set(x + rand(-W * 0.3, W * 0.3), H + capH + s * 0.3, z + rand(-D * 0.3, D * 0.3)); ac.isPickable = false;
      }
    }
    // Parody wordmark signage (additive branding, in the account's accent colour).
    // Storefront band on the boulevard-facing facade (readable at FPS eye height) for
    // EVERY account; tall accounts also crown the skyline with a rooftop sign.
    body.metadata = { account: acct.name, parodyOf: acct.parodyOf, tier: acct.tier };
    const side = x >= 0 ? 1 : -1;                 // which way the boulevard is
    const faceY = side > 0 ? -Math.PI / 2 : Math.PI / 2; // plane normal → toward boulevard
    const sMat = signMaterialFor(acct);
    const swStore = Math.min(W * 1.12, 12);
    const storeY = Math.max(3.2, Math.min(H - 1.6, 5.2));
    // DOUBLE-SIDED → the wordmark reads upright whether the camera is on the +X or −X side
    // of the boulevard (fixes the mirrored-text bug). frontUVs/backUVs cancel the back mirror.
    const store = track(meshes, MeshBuilder.CreatePlane(`world_sign_${id}`, { width: swStore, height: swStore / 4, sideOrientation: Mesh.DOUBLESIDE, frontUVs: SIGN_FRONT_UV, backUVs: SIGN_BACK_UV }, scene));
    store.material = sMat; store.rotation.y = faceY; store.isPickable = false;
    store.position.set(x - side * (W / 2 + 0.25), storeY, z); // stand off the facade → no z-fight
    if (tierIdx <= 1) {
      const swRoof = Math.min(W * 1.3, 15);
      const roof = track(meshes, MeshBuilder.CreatePlane(`world_signroof_${id}`, { width: swRoof, height: swRoof / 4, sideOrientation: Mesh.DOUBLESIDE, frontUVs: SIGN_FRONT_UV, backUVs: SIGN_BACK_UV }, scene));
      roof.material = sMat; roof.rotation.y = faceY; roof.isPickable = false;
      roof.position.set(x - side * (W * 0.32), H + (0.9 + H * 0.012) + swRoof / 8 + 0.6, z);
    }

    footprints.push({ x, z, hw: W / 2 + 1.5, hd: D / 2 + 1.5 });
  };

  // ── Nature prop bases (round + pine trees, bushes) — used in parks/plazas/streets. ──
  const trunkMat = track(mats, new PBRMaterial("world_trunk_mat", scene));
  trunkMat.albedoColor = Color3.FromHexString("#6b4a2b"); trunkMat.metallic = 0; trunkMat.roughness = 0.9;
  const trunk = track(meshes, MeshBuilder.CreateCylinder("world_trunk", { height: 6, diameterBottom: 1.1, diameterTop: 0.7, tessellation: 7 }, scene));
  trunk.material = trunkMat; trunk.isPickable = false; trunk.receiveShadows = true; trunk.setEnabled(false);
  shadowGen.addShadowCaster(trunk);

  const roundMat = track(mats, new PBRMaterial("world_round_mat", scene));
  roundMat.albedoColor = Color3.FromHexString("#3f8f3a"); roundMat.metallic = 0; roundMat.roughness = 0.95;
  const roundFol = track(meshes, MeshBuilder.CreateSphere("world_round_fol", { diameter: 7, segments: 6 }, scene));
  roundFol.material = roundMat; roundFol.isPickable = false; roundFol.setEnabled(false);
  shadowGen.addShadowCaster(roundFol);

  const pineMat = track(mats, new PBRMaterial("world_pine_mat", scene));
  pineMat.albedoColor = Color3.FromHexString("#2f7a44"); pineMat.metallic = 0; pineMat.roughness = 0.95;
  const pineCone = track(meshes, MeshBuilder.CreateCylinder("world_pine_cone", { height: 5, diameterBottom: 4.6, diameterTop: 0, tessellation: 8 }, scene));
  pineCone.material = pineMat; pineCone.isPickable = false; pineCone.setEnabled(false);
  shadowGen.addShadowCaster(pineCone);

  const bushMat = track(mats, new PBRMaterial("world_bush_mat", scene));
  bushMat.albedoColor = Color3.FromHexString("#4ea049"); bushMat.metallic = 0; bushMat.roughness = 1;
  const bush = track(meshes, MeshBuilder.CreateSphere("world_bush", { diameter: 2.4, segments: 6 }, scene));
  bush.material = bushMat; bush.isPickable = false; bush.receiveShadows = true; bush.setEnabled(false);

  // Bench (seat + back) + planter bases.
  const benchMat = track(mats, new PBRMaterial("world_bench_mat", scene));
  benchMat.albedoColor = Color3.FromHexString("#8a6b45"); benchMat.metallic = 0; benchMat.roughness = 0.8;
  const benchSeat = track(meshes, MeshBuilder.CreateBox("world_bench_seat", { width: 2.2, height: 0.18, depth: 0.7 }, scene));
  benchSeat.material = benchMat; benchSeat.isPickable = false; benchSeat.setEnabled(false); benchSeat.receiveShadows = true;
  shadowGen.addShadowCaster(benchSeat);
  const benchBack = track(meshes, MeshBuilder.CreateBox("world_bench_back", { width: 2.2, height: 0.6, depth: 0.12 }, scene));
  benchBack.material = benchMat; benchBack.isPickable = false; benchBack.setEnabled(false);
  const planterMat = track(mats, new PBRMaterial("world_planter_mat", scene));
  planterMat.albedoColor = Color3.FromHexString("#9a9da3"); planterMat.metallic = 0; planterMat.roughness = 0.7;
  const planterBox = track(meshes, MeshBuilder.CreateBox("world_planter_box", { width: 2.4, height: 1.0, depth: 2.4 }, scene));
  planterBox.material = planterMat; planterBox.isPickable = false; planterBox.setEnabled(false); planterBox.receiveShadows = true;
  shadowGen.addShadowCaster(planterBox);

  let trunkN = 0, roundN = 0, pineN = 0, bushN = 0, seatN = 0, backN = 0, planterN = 0;
  const placedTrunk = () => (trunkN++ === 0 ? (trunk.setEnabled(true), trunk) : trunk.createInstance(`world_trunk_${trunkN}`));
  const placedRound = () => (roundN++ === 0 ? (roundFol.setEnabled(true), roundFol) : roundFol.createInstance(`world_round_${roundN}`));
  const placedPine = () => (pineN++ === 0 ? (pineCone.setEnabled(true), pineCone) : pineCone.createInstance(`world_pine_${pineN}`));
  const placedBush = () => (bushN++ === 0 ? (bush.setEnabled(true), bush) : bush.createInstance(`world_bush_${bushN}`));
  const placedSeat = () => (seatN++ === 0 ? (benchSeat.setEnabled(true), benchSeat) : benchSeat.createInstance(`world_seat_${seatN}`));
  const placedBack = () => (backN++ === 0 ? (benchBack.setEnabled(true), benchBack) : benchBack.createInstance(`world_back_${backN}`));
  const placedPlanter = () => (planterN++ === 0 ? (planterBox.setEnabled(true), planterBox) : planterBox.createInstance(`world_planter_${planterN}`));

  const roundTree = (x, z, sc) => {
    const tk = placedTrunk(); tk.position.set(x, 3 * sc, z); tk.scaling.setAll(sc); tk.isPickable = false;
    const fl = placedRound(); fl.position.set(x, 6.4 * sc, z); fl.scaling.setAll(sc * rand(0.85, 1.2)); fl.isPickable = false;
  };
  const pineTree = (x, z, sc) => {
    const tk = placedTrunk(); tk.position.set(x, 3 * sc, z); tk.scaling.set(sc * 0.7, sc, sc * 0.7); tk.isPickable = false;
    const c1 = placedPine(); c1.position.set(x, 5.5 * sc, z); c1.scaling.setAll(sc); c1.isPickable = false;
    const c2 = placedPine(); c2.position.set(x, 8.4 * sc, z); c2.scaling.setAll(sc * 0.7); c2.isPickable = false;
  };
  const placeBench = (x, z, rot) => {
    const s = placedSeat(); s.position.set(x, 0.55, z); s.rotation.y = rot; s.isPickable = false;
    const b = placedBack(); b.position.set(x - Math.sin(rot) * 0.3, 0.95, z - Math.cos(rot) * 0.3); b.rotation.y = rot; b.isPickable = false;
  };

  // ── Grass-blade thin-instance accumulator (parks only → one draw call total). ──
  const bladeM = [], bladeC = [];
  const _bs = new Vector3(), _bp = new Vector3(), _bm = new Matrix();
  const QID = Quaternion.Identity();
  const pushGrass = (x0, x1, z0, z1, count) => {
    for (let i = 0; i < count; i++) {
      const h = rand(0.5, 1.7);
      _bs.set(1, h, 1); _bp.set(rand(x0, x1), 0.2 + 0.5 * h, rand(z0, z1));
      Matrix.ComposeToRef(_bs, Quaternion.FromEulerAngles((rand(-0.5, 0.5)) * 0.4, rand(0, Math.PI * 2), (rand(-0.5, 0.5)) * 0.4), _bp, _bm);
      for (let k = 0; k < 16; k++) bladeM.push(_bm.m[k]);
      bladeC.push(0.22 + rand(0, 0.12), 0.44 + rand(0, 0.22), 0.16 + rand(0, 0.1), 1);
    }
  };

  // ── Road-marking thin-instance accumulator (lane lines, edge lines, crosswalks). ──
  const markM = [];
  const _ms = new Vector3(), _mp = new Vector3(), _mm = new Matrix();
  const pushMark = (x, z, sx, sz) => {
    _ms.set(sx, 1, sz); _mp.set(x, 0.05, z);
    Matrix.ComposeToRef(_ms, QID, _mp, _mm);
    for (let k = 0; k < 16; k++) markM.push(_mm.m[k]);
  };

  // ── Radar rings (Quivly "Radar" surface) — placed on plazas + sector starts. ──
  const radarRings = [];  // { mat, base }
  const radarSweeps = []; // spinning hands
  const addRadar = (x, z, R, accC) => {
    const ringMat = track(mats, new StandardMaterial(`world_radar_mat_${radarRings.length}`, scene));
    ringMat.disableLighting = true; ringMat.diffuseColor = new Color3(0, 0, 0); ringMat.specularColor = new Color3(0, 0, 0);
    ringMat.emissiveColor = accC.clone(); ringMat.emissiveTexture = radarTex; ringMat.opacityTexture = radarTex; ringMat.backFaceCulling = false;
    const disc = track(meshes, MeshBuilder.CreateDisc(`world_radar_${radarRings.length}`, { radius: R, tessellation: 40 }, scene));
    disc.material = ringMat; disc.rotation.x = Math.PI / 2; disc.position.set(x, 0.22, z); disc.isPickable = false;
    radarRings.push({ mat: ringMat, base: accC });
    const holder = track(meshes, MeshBuilder.CreateBox(`world_radar_hold_${radarSweeps.length}`, { size: 0.01 }, scene));
    holder.position.set(x, 0.24, z); holder.isVisible = false; holder.isPickable = false;
    const hand = track(meshes, MeshBuilder.CreateBox(`world_radar_hand_${radarSweeps.length}`, { width: R, height: 0.06, depth: 0.7 }, scene));
    hand.material = neon(`world_radar_hand_mat_${radarSweeps.length}`, accC, 0.9); hand.material.alpha = 0.55;
    regGlow(hand.material, 1.4); // radar sweep brightens at night

    hand.position.set(R / 2, 0, 0); hand.parent = holder; hand.isPickable = false;
    radarSweeps.push(holder);
  };

  // ── Build the city block grid: roads (asphalt base) + slabbed blocks + content. ──
  const sectorOfZ = (z) => Math.min(SECTORS - 1, Math.max(0, Math.floor(z / SECTOR_LEN)));

  // Block columns = gaps between adjacent vertical roads.
  const cols = [];
  for (let i = 0; i < V_ROADS.length - 1; i++) {
    const x0 = V_ROADS[i].cx + V_ROADS[i].hw;
    const x1 = V_ROADS[i + 1].cx - V_ROADS[i + 1].hw;
    cols.push({ x0, x1, cx: (x0 + x1) / 2, w: x1 - x0 });
  }
  // Block rows = gaps between adjacent cross roads.
  const rows = [];
  for (let j = 0; j < H_ROADS.length - 1; j++) {
    const z0 = H_ROADS[j] + ROAD_HW;
    const z1 = H_ROADS[j + 1] - ROAD_HW;
    rows.push({ z0, z1, cz: (z0 + z1) / 2, d: z1 - z0 });
  }

  const accountArr = (tierIdx) => Math.round(TIERS[tierIdx].arr * rand(0.55, 1.6));

  const buildBuildingCell = (col, row, sector) => {
    makeSlab(col.cx, row.cz, col.w, row.d, sidewalkMat, TILE_SIDEWALK, `world_blk_${col.cx}_${row.cz}`);
    const mix = SECTOR_MIX[sector];
    const back = Math.abs(col.cx) > 80;            // outer columns = back skyline layer
    const side = col.cx > 0 ? 1 : -1;
    const edge = side > 0 ? col.x0 : col.x1;        // edge nearest the boulevard
    let z = row.z0 + 4; let guard = 0;
    while (z < row.z1 - 5 && guard < 6) {
      guard++;
      const tierIdx = wpick(back ? BACK_TIER_BIAS : mix.tierBias);
      const bucketIdx = wpick(mix.buckets);
      const t = TIERS[tierIdx];
      const W = rand(t.w[0], t.w[1]), D = rand(t.d[0], t.d[1]), H = rand(t.h[0], t.h[1]);
      const bx = side > 0 ? edge + 3 + W / 2 : edge - 3 - W / 2;
      const bz = z + D / 2;
      makeBuilding(bx, bz, W, D, H, bucketIdx, tierIdx, accountArr(tierIdx));
      z += D + rand(5, 9);
    }
  };

  const buildParkCell = (col, row, accC) => {
    makeSlab(col.cx, row.cz, col.w, row.d, grassMat, TILE_GRASS, `world_park_${col.cx}_${row.cz}`);
    // A paver cross-path through the park (lifted a touch above the grass slab → no z-fight).
    makeSlab(col.cx, row.cz, col.w, 2.6, paverMat, TILE_PAVER, `world_parkpath_${col.cx}_${row.cz}`).position.y = 0.13;
    const area = col.w * row.d;
    pushGrass(col.x0 + 1, col.x1 - 1, row.z0 + 1, row.z1 - 1, Math.floor(area * 1.4));
    const n = ri(3, 5);
    for (let i = 0; i < n; i++) {
      const x = rand(col.x0 + 3, col.x1 - 3), z = rand(row.z0 + 3, row.z1 - 3);
      if (Math.abs(z - row.cz) < 2.2) continue; // keep the path clear
      const roll = rnd();
      if (roll < 0.55) roundTree(x, z, rand(1.0, 1.8));
      else if (roll < 0.85) pineTree(x, z, rand(1.0, 1.7));
      else { const bs = rand(0.9, 1.6); const b = placedBush(); b.position.set(x, 0.2 + bs, z); b.scaling.setAll(bs); b.isPickable = false; }
    }
    placeBench(col.cx - col.w * 0.18, row.cz + 0.1, Math.PI / 2);
    placeBench(col.cx + col.w * 0.18, row.cz - 0.1, -Math.PI / 2);
  };

  const buildPlazaCell = (col, row, accC) => {
    makeSlab(col.cx, row.cz, col.w, row.d, paverMat, TILE_PAVER, `world_plaza_${col.cx}_${row.cz}`);
    addRadar(col.cx, row.cz, Math.min(col.w, row.d) * 0.34, accC);
    // Ring of planters + benches around the radar.
    const r = Math.min(col.w, row.d) * 0.42;
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI / 2 + Math.PI / 4;
      const px = col.cx + Math.cos(ang) * r, pz = row.cz + Math.sin(ang) * r;
      const pl = placedPlanter(); pl.position.set(px, 0.7, pz); pl.scaling.setAll(rand(0.8, 1.1)); pl.isPickable = false;
      const bs = rand(0.8, 1.1); const b = placedBush(); b.position.set(px, 1.2 + bs * 0.4, pz); b.scaling.setAll(bs); b.isPickable = false;
    }
    placeBench(col.cx - r * 0.7, row.cz, Math.PI / 2);
    placeBench(col.cx + r * 0.7, row.cz, -Math.PI / 2);
    footprints.push({ x: col.cx, z: row.cz, hw: col.w / 2, hd: row.d / 2 });
  };

  // Assign cell types per sector — at least one park + one plaza each, preferring the
  // inner (boulevard-facing) columns so the variety is visible from the play lane.
  for (let s = 0; s < SECTORS; s++) {
    const sectorRows = rows.filter((rw) => sectorOfZ(rw.cz) === s);
    const cells = [];
    for (const col of cols) for (const rw of sectorRows) cells.push({ col, row: rw });
    const inner = cells.filter((c) => Math.abs(c.col.cx) < 60);
    const pool = inner.length >= 2 ? inner : cells;
    const parkCell = pool[Math.floor(rnd() * pool.length)];
    let plazaCell = pool[Math.floor(rnd() * pool.length)];
    let tries = 0;
    while (plazaCell === parkCell && tries++ < 8) plazaCell = pool[Math.floor(rnd() * pool.length)];
    for (const cell of cells) {
      const accC = PAL[s].accC;
      if (cell === parkCell) buildParkCell(cell.col, cell.row, accC);
      else if (cell === plazaCell) buildPlazaCell(cell.col, cell.row, accC);
      else if (rnd() < 0.1) buildParkCell(cell.col, cell.row, accC);
      else buildBuildingCell(cell.col, cell.row, s);
    }
  }

  // ── Road markings: boulevard centre dashes + edge lines + zebra crosswalks. ───
  const markMat = track(mats, new StandardMaterial("world_mark_mat", scene));
  markMat.diffuseColor = new Color3(0.95, 0.95, 0.93);
  markMat.specularColor = new Color3(0, 0, 0);
  markMat.emissiveColor = new Color3(0.12, 0.12, 0.11); // lifts paint out of shadow without bloom
  regGlow(markMat, 1.6); // lane lines/crosswalks stay legible (and glow faintly) at night
  const markBase = track(meshes, MeshBuilder.CreateBox("world_mark_base", { width: 1, height: 0.04, depth: 1 }, scene));
  markBase.material = markMat; markBase.isPickable = false; markBase.receiveShadows = false;

  const crossZs = H_ROADS.filter((z) => z > BOUNDS.minZ + 2 && z < BOUNDS.maxZ - 2);
  const nearCross = (z) => crossZs.some((cz) => Math.abs(z - cz) < 9);
  // Boulevard centre dashes (skip intersection zones).
  for (let z = BOUNDS.minZ + 4; z < BOUNDS.maxZ - 2; z += 7) { if (!nearCross(z)) pushMark(0, z, 0.4, 3.4); }
  // Boulevard solid edge lines.
  for (const ex of [-13.5, 13.5]) pushMark(ex, (BOUNDS.minZ + BOUNDS.maxZ) / 2, 0.35, BOUNDS.maxZ - BOUNDS.minZ - 8);
  // Zebra crosswalks across the boulevard at every intersection.
  for (const cz of crossZs) for (let bx = -13; bx <= 13; bx += 2.0) pushMark(bx, cz, 0.8, 5.0);
  // Lane dashes along each cross street (short, across the boulevard frontage).
  for (const cz of crossZs) for (let lx = -134; lx <= 134; lx += 6) { if (Math.abs(lx) > 18) pushMark(lx, cz, 2.6, 0.32); }
  markBase.thinInstanceSetBuffer("matrix", new Float32Array(markM), 16);

  // ── Streetlights + street trees lining the boulevard sidewalks. ──────────────
  const poleMat = track(mats, new PBRMaterial("world_pole_mat", scene));
  poleMat.albedoColor = new Color3(0.24, 0.25, 0.28); poleMat.metallic = 0.1; poleMat.roughness = 0.6;
  const poleBase = track(meshes, MeshBuilder.CreateCylinder("world_pole_base", { height: 8, diameter: 0.4, tessellation: 6 }, scene));
  poleBase.material = poleMat; poleBase.isPickable = false; poleBase.setEnabled(false); poleBase.receiveShadows = true;
  shadowGen.addShadowCaster(poleBase);
  const armBase = track(meshes, MeshBuilder.CreateBox("world_arm_base", { width: 3, height: 0.25, depth: 0.25 }, scene));
  armBase.material = poleMat; armBase.isPickable = false; armBase.setEnabled(false);
  const lampMat = track(mats, new PBRMaterial("world_lamp_mat", scene));
  lampMat.albedoColor = new Color3(0.9, 0.9, 0.85); lampMat.metallic = 0; lampMat.roughness = 0.4;
  lampMat.emissiveColor = new Color3(0.18, 0.17, 0.12); // faint warm glass (daytime, below bloom)
  regGlow(lampMat, 4.0); // streetlights blaze warm at night → the city reads as lived-in after dark
  const lampBase = track(meshes, MeshBuilder.CreateBox("world_lamp_base", { width: 1.1, height: 0.3, depth: 0.6 }, scene));
  lampBase.material = lampMat; lampBase.isPickable = false; lampBase.setEnabled(false);

  let poleN = 0, armN = 0, lampN = 0;
  const placeStreetlight = (x, z, side) => {
    const p = poleN++ === 0 ? (poleBase.setEnabled(true), poleBase) : poleBase.createInstance(`world_pole_${poleN}`);
    p.position.set(x, 4, z); p.isPickable = false;
    const a = armN++ === 0 ? (armBase.setEnabled(true), armBase) : armBase.createInstance(`world_arm_${armN}`);
    a.position.set(x - side * 1.5, 7.6, z); a.isPickable = false;
    const l = lampN++ === 0 ? (lampBase.setEnabled(true), lampBase) : lampBase.createInstance(`world_lamp_${lampN}`);
    l.position.set(x - side * 2.8, 7.4, z); l.isPickable = false;
  };
  let sli = 0;
  for (let z = BOUNDS.minZ + 16; z < BOUNDS.maxZ - 8; z += 26) {
    const side = (sli % 2 === 0) ? 1 : -1; sli++;
    placeStreetlight(side * 18.5, z, side);
    // a street tree opposite the light, on the other sidewalk edge
    roundTree(-side * 20, z + 13, rand(1.0, 1.5));
  }

  // ── CHURNED wasteland — the grim far edge beyond the gate (you keep accounts out). ──
  {
    const W0 = -150, W1 = 150, Z0 = GATE_Z + 8, Z1 = WALL_Z1 - 6;
    const dead = track(meshes, MeshBuilder.CreateGround("world_waste_ground", { width: W1 - W0, height: Z1 - Z0, subdivisions: 1 }, scene));
    dead.position.set((W0 + W1) / 2, 0.05, (Z0 + Z1) / 2); dead.isPickable = false; dead.receiveShadows = true;
    const deadMat = track(mats, new PBRMaterial("world_waste_mat", scene));
    deadMat.albedoColor = new Color3(1, 1, 1); deadMat.albedoTexture = deadTex; deadMat.metallic = 0; deadMat.roughness = 1;
    deadTex.uScale = (W1 - W0) / 10; deadTex.vScale = (Z1 - Z0) / 10;
    dead.material = deadMat;

    const huskBase = track(meshes, MeshBuilder.CreateBox("world_husk_base", { size: 1 }, scene));
    huskBase.material = huskMat; huskBase.isPickable = false; huskBase.receiveShadows = true; huskBase.setEnabled(false);
    shadowGen.addShadowCaster(huskBase);
    let huskFirst = true;
    for (let i = 0; i < 22; i++) {
      const w = rand(7, 14), d = rand(7, 13), h = rand(12, 50);
      const x = rand(W0 + 8, W1 - 8), z = rand(Z0 + 6, Z1 - 8);
      const hk = huskFirst ? (huskBase.setEnabled(true), huskFirst = false, huskBase) : huskBase.createInstance(`world_husk_${i}`);
      hk.scaling.set(w, h, d); hk.position.set(x, h / 2 - rand(0, 2), z);
      hk.rotation.set(rand(-0.12, 0.12), rand(0, Math.PI), rand(-0.16, 0.16)); hk.isPickable = false;
    }
    // Bare dead trees.
    const deadTrunkMat = track(mats, new PBRMaterial("world_deadtree_mat", scene));
    deadTrunkMat.albedoColor = new Color3(0.16, 0.13, 0.11); deadTrunkMat.metallic = 0; deadTrunkMat.roughness = 1;
    const deadTrunk = track(meshes, MeshBuilder.CreateCylinder("world_deadtree_base", { height: 6, diameterBottom: 0.9, diameterTop: 0.2, tessellation: 5 }, scene));
    deadTrunk.material = deadTrunkMat; deadTrunk.isPickable = false; deadTrunk.setEnabled(false);
    let dtFirst = true;
    for (let i = 0; i < 12; i++) {
      const x = rand(W0, W1), z = rand(Z0, Z1), sc = rand(0.8, 1.8);
      const dt = dtFirst ? (deadTrunk.setEnabled(true), dtFirst = false, deadTrunk) : deadTrunk.createInstance(`world_deadtree_${i}`);
      dt.position.set(x, 3 * sc, z); dt.scaling.set(sc, sc, sc); dt.rotation.z = rand(-0.3, 0.3); dt.isPickable = false;
    }
    // CHURNED monument, leaning, facing back toward the player.
    const churnSign = track(texes, makeSignTexture("CHURNED", "ACCOUNTS LOST", "#7f1d1d", "#fca5a5"));
    const churnMat = track(mats, new StandardMaterial("world_churn_sign_mat", scene));
    churnMat.disableLighting = true; churnMat.emissiveColor = new Color3(0.5, 0.12, 0.12);
    churnMat.emissiveTexture = churnSign; churnMat.opacityTexture = churnSign; churnMat.backFaceCulling = false;
    const churnPlane = track(meshes, MeshBuilder.CreatePlane("world_churn_sign", { width: 20, height: 5 }, scene));
    churnPlane.material = churnMat; churnPlane.position.set(0, 6, Z0 + 4); churnPlane.rotation.set(0.04, Math.PI, 0.03); churnPlane.isPickable = false;
  }

  // ── Perimeter wall — tall facade-skinned ring so there's never a void to see. ──
  const mkWall = (name, w, h, d, x, z, tint) => {
    const uW = Math.max(2, Math.round(w / COL_W)), uD = Math.max(2, Math.round(d / COL_W)), vT = Math.max(2, Math.round(h / FLOOR_H));
    const wallUV = new Vector4(0.02, 0.02, 0.05, 0.05);
    const faceUV = [new Vector4(0, 0, uW, vT), new Vector4(0, 0, uW, vT), new Vector4(0, 0, uD, vT), new Vector4(0, 0, uD, vT), wallUV, wallUV];
    const m = track(meshes, MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, wrap: true, faceUV }, scene));
    m.position.set(x, h / 2, z); m.isPickable = false; m.receiveShadows = true;
    const mat = track(mats, new PBRMaterial(`${name}_mat`, scene));
    mat.albedoTexture = facadeTex; mat.albedoColor = tint; mat.metallic = 0; mat.roughness = 0.55; mat.environmentIntensity = 0.4;
    m.material = mat;
    return m;
  };
  const wallTint = new Color3(0.62, 0.66, 0.74);
  const wallLen = WALL_Z1 - WALL_Z0, wallSpanX = (WALL_X + 8) * 2, wallH = 44, wallCZ = (WALL_Z0 + WALL_Z1) / 2;
  mkWall("world_wall_w", 6, wallH, wallLen, -WALL_X, wallCZ, wallTint);
  mkWall("world_wall_e", 6, wallH, wallLen, WALL_X, wallCZ, wallTint);
  mkWall("world_wall_s", wallSpanX, wallH, 6, 0, WALL_Z0, wallTint);
  mkWall("world_wall_n", wallSpanX, wallH, 6, 0, WALL_Z1, wallTint.scale(0.7)); // darker behind the churn

  // ── Sector monument signs — clean corporate wayfinding for the product flow. ──
  const signBaseMat = track(mats, new PBRMaterial("world_sign_base_mat", scene));
  signBaseMat.albedoColor = new Color3(0.93, 0.94, 0.97); signBaseMat.metallic = 0; signBaseMat.roughness = 0.5;
  for (let s = 0; s < SECTORS; s++) {
    const pal = PAL[s];
    const z = s * SECTOR_LEN + 6;
    const x = BLVD_HW + 3; // a roadside monument on the right sidewalk, clear of the lane
    const base = track(meshes, MeshBuilder.CreateBox(`world_sign_base_${s}`, { width: 9, depth: 1.3, height: 4.2 }, scene));
    base.material = signBaseMat; base.position.set(x, 2.3, z); base.isPickable = false; base.receiveShadows = true;
    shadowGen.addShadowCaster(base);
    const bar = track(meshes, MeshBuilder.CreateBox(`world_sign_bar_${s}`, { width: 9.1, depth: 0.4, height: 0.5 }, scene));
    bar.material = neon(`world_sign_bar_mat_${s}`, pal.accC, 1.2); bar.position.set(x, 0.9, z - 0.66); bar.isPickable = false;
    const signTex = track(texes, makeSignTexture(pal.name.toUpperCase(), pal.sub, "#0f172a", pal.accent));
    const panelMat = track(mats, new StandardMaterial(`world_sign_panel_mat_${s}`, scene));
    panelMat.diffuseColor = new Color3(1, 1, 1); panelMat.diffuseTexture = signTex;
    panelMat.emissiveColor = new Color3(0.4, 0.4, 0.42); panelMat.emissiveTexture = signTex;
    panelMat.opacityTexture = signTex; panelMat.specularColor = new Color3(0, 0, 0);
    regGlow(panelMat, 1.4); // sector wayfinding signs glow up at night
    const panel = track(meshes, MeshBuilder.CreatePlane(`world_sign_panel_${s}`, { width: 8.4, height: 2.6 }, scene));
    panel.material = panelMat; panel.position.set(x, 2.8, z - 0.67); panel.rotation.y = Math.PI; panel.isPickable = false;
  }

  // ── The Renewal Gate — clean, brand-indigo deadline landmark spanning the boulevard. ──
  const gateRoot = track(meshes, MeshBuilder.CreateBox("world_gate_root", { size: 0.01 }, scene));
  gateRoot.position.set(0, 0, GATE_Z); gateRoot.isVisible = false; gateRoot.isPickable = false;
  const INDIGO_C = Color3.FromHexString(INDIGO);
  const INDIGO_LT_C = Color3.FromHexString(INDIGO_LT);

  const gatePillarMat = track(mats, new PBRMaterial("world_gate_pillar_mat", scene));
  gatePillarMat.albedoColor = new Color3(0.95, 0.96, 0.99); gatePillarMat.metallic = 0.0; gatePillarMat.roughness = 0.45;
  gatePillarMat.emissiveColor = INDIGO_C.scale(0.05);
  for (const side of [-1, 1]) {
    const pillar = track(meshes, MeshBuilder.CreateBox(`world_gate_pillar_${side}`, { width: 5, depth: 5, height: 52 }, scene));
    pillar.position.set(side * 22, 26, 0); pillar.material = gatePillarMat; pillar.parent = gateRoot;
    pillar.isPickable = false; pillar.checkCollisions = true; pillar.receiveShadows = true;
    const trim = track(meshes, MeshBuilder.CreateBox(`world_gate_trim_${side}`, { width: 0.7, depth: 0.7, height: 48 }, scene));
    trim.position.set(side * 19.6, 26, -2.5); trim.material = regGlow(neon(`world_gate_trim_mat_${side}`, INDIGO_LT_C, 1.0), 1.3); trim.parent = gateRoot; trim.isPickable = false;
  }
  shadowGen.addShadowCaster(gateRoot, true);

  const beam = track(meshes, MeshBuilder.CreateBox("world_gate_beam", { width: 54, depth: 5, height: 6 }, scene));
  beam.position.set(0, 51, 0); beam.material = gatePillarMat; beam.parent = gateRoot; beam.isPickable = false;

  const gateSign = track(texes, makeSignTexture("RENEWAL DAY", "CLOSE THE QUARTER · QUIVLY", "#ffffff", INDIGO_LT));
  const gateSignMat = track(mats, new StandardMaterial("world_gate_sign_mat", scene));
  gateSignMat.disableLighting = true; gateSignMat.emissiveColor = new Color3(1, 1, 1);
  gateSignMat.emissiveTexture = gateSign; gateSignMat.opacityTexture = gateSign; gateSignMat.backFaceCulling = false;
  const banner = track(meshes, MeshBuilder.CreatePlane("world_gate_banner", { width: 42, height: 5.6 }, scene));
  banner.material = gateSignMat; banner.position.set(0, 51, -2.7); banner.rotation.y = Math.PI; banner.parent = gateRoot; banner.isPickable = false;

  const crest = track(meshes, MeshBuilder.CreateBox("world_gate_crest", { width: 54, depth: 1.0, height: 0.9 }, scene));
  crest.position.set(0, 47.6, -2.6); crest.material = regGlow(neon("world_gate_crest_mat", INDIGO_C, 1.2), 1.3); crest.parent = gateRoot; crest.isPickable = false;

  const gateCoreMat = track(mats, new StandardMaterial("world_gate_core_mat", scene));
  gateCoreMat.disableLighting = true; gateCoreMat.diffuseColor = new Color3(0, 0, 0); gateCoreMat.specularColor = new Color3(0, 0, 0);
  gateCoreMat.backFaceCulling = false; gateCoreMat.alpha = 0.4; gateCoreMat.emissiveColor = INDIGO_C.clone();
  const core = track(meshes, MeshBuilder.CreateDisc("world_gate_core", { radius: 15, tessellation: 48 }, scene));
  core.position.set(0, 24, 0.4); core.material = gateCoreMat; core.parent = gateRoot; core.isPickable = false;

  const ringHolder = track(meshes, MeshBuilder.CreateBox("world_gate_ringholder", { size: 0.01 }, scene));
  ringHolder.position.set(0, 24, 0); ringHolder.rotation.x = Math.PI / 2; ringHolder.isVisible = false; ringHolder.isPickable = false; ringHolder.parent = gateRoot;
  const gRingMat = regGlow(neon("world_gate_ring_mat", INDIGO_LT_C, 1.1), 1.3);
  const ring1 = track(meshes, MeshBuilder.CreateTorus("world_gate_ring1", { diameter: 38, thickness: 1.1, tessellation: 48 }, scene));
  const ring2 = track(meshes, MeshBuilder.CreateTorus("world_gate_ring2", { diameter: 28, thickness: 0.8, tessellation: 40 }, scene));
  for (const r of [ring1, ring2]) { r.material = gRingMat; r.parent = ringHolder; r.isPickable = false; }

  // Commit accumulated park grass blades (one thin-instance draw call for the whole city).
  if (bladeM.length) {
    const blade = track(meshes, MeshBuilder.CreateCylinder("world_grass_blade", { height: 1, diameterBottom: 0.11, diameterTop: 0.0, tessellation: 3 }, scene));
    const bladeMat = track(mats, new PBRMaterial("world_grass_blade_mat", scene));
    bladeMat.albedoColor = new Color3(0.34, 0.56, 0.24); bladeMat.metallic = 0; bladeMat.roughness = 1; bladeMat.backFaceCulling = false;
    blade.material = bladeMat; blade.isPickable = false; blade.receiveShadows = true;
    blade.thinInstanceSetBuffer("matrix", new Float32Array(bladeM), 16);
    blade.thinInstanceSetBuffer("color", new Float32Array(bladeC), 4);
  }

  // ── Drifting dust motes — soft daylight life that follows the player. ─────────
  const moteEmitter = track(meshes, MeshBuilder.CreateBox("world_mote_emitter", { size: 0.01 }, scene));
  moteEmitter.isVisible = false; moteEmitter.isPickable = false;
  const motes = new ParticleSystem("world_motes", 280, scene);
  motes.particleTexture = dotTex; motes.emitter = moteEmitter;
  motes.minEmitBox = new Vector3(-40, 0, -50); motes.maxEmitBox = new Vector3(40, 24, 60);
  motes.color1 = new Color4(1.0, 0.98, 0.88, 0.45); motes.color2 = new Color4(1.0, 1.0, 0.94, 0.22); motes.colorDead = new Color4(1, 1, 0.9, 0);
  motes.minSize = 0.06; motes.maxSize = 0.26; motes.minLifeTime = 5; motes.maxLifeTime = 11; motes.emitRate = 55;
  motes.blendMode = ParticleSystem.BLENDMODE_STANDARD; motes.gravity = new Vector3(0, 0.15, 0);
  motes.direction1 = new Vector3(-0.5, 0.2, -0.3); motes.direction2 = new Vector3(0.5, 0.6, 0.3);
  motes.minEmitPower = 0.2; motes.maxEmitPower = 0.6; motes.updateSpeed = 0.012; motes.start();

  // ── DAY ↔ NIGHT cycle ────────────────────────────────────────────────────────
  // Driven by the renewal clock: progress = game.elapsed / RENEWAL_MS (pinned to 1 in
  // overtime) → bright DAY at the start, warm GOLDEN-HOUR as the timer runs down, NIGHT
  // by renewal/overtime — a clear arc the player feels as time pressure. Each keyframe
  // carries a complete atmosphere (sky gradient, fog/clear, sun light dir/colour/intensity,
  // hemi/ambient, sun+moon+star fades, and a nightAmt that drives the neon boost). Per
  // frame we find the surrounding pair, lerp ONCE into preallocated buffers (no allocation),
  // and push the result everywhere. K0 reproduces the original daytime look EXACTLY
  // (nightAmt 0 → every emissive-boost factor is ×1 → the city renders identically at start).
  const C = (hex) => Color3.FromHexString(hex);
  const DN_KEYS = [
    { at: 0.00, zen: C("#1f5fc4"), mid: C("#5f9ce4"), hor: C("#a4c6ec"), fog: C("#a4c6ec"), clear: new Color3(0.66, 0.80, 0.95), dir: new Vector3(-0.42, -1, 0.34),    sun: new Color3(1.00, 0.97, 0.90), sunI: 2.25, hs: new Color3(0.92, 0.95, 1.00), hg: new Color3(0.36, 0.37, 0.40), hi: 0.85, amb: new Color3(0.58, 0.64, 0.72), disc: new Color3(1.00, 0.97, 0.86), sunO: 0.95, moonO: 0.00, starO: 0.00, night: 0.00 },
    { at: 0.45, zen: C("#245fbf"), mid: C("#6a9ad8"), hor: C("#b6cdec"), fog: C("#b6cdec"), clear: new Color3(0.69, 0.81, 0.93), dir: new Vector3(-0.55, -0.82, 0.30), sun: new Color3(1.00, 0.94, 0.83), sunI: 2.05, hs: new Color3(0.95, 0.95, 0.98), hg: new Color3(0.36, 0.36, 0.38), hi: 0.82, amb: new Color3(0.56, 0.60, 0.66), disc: new Color3(1.00, 0.90, 0.72), sunO: 1.00, moonO: 0.00, starO: 0.00, night: 0.05 },
    { at: 0.72, zen: C("#3a63a8"), mid: C("#d08a55"), hor: C("#f6b46b"), fog: C("#efa666"), clear: new Color3(0.85, 0.62, 0.40), dir: new Vector3(-0.72, -0.42, 0.24), sun: new Color3(1.00, 0.72, 0.44), sunI: 1.70, hs: new Color3(1.00, 0.84, 0.66), hg: new Color3(0.34, 0.30, 0.30), hi: 0.78, amb: new Color3(0.50, 0.43, 0.40), disc: new Color3(1.00, 0.62, 0.32), sunO: 1.00, moonO: 0.05, starO: 0.08, night: 0.24 },
    { at: 0.90, zen: C("#232a5e"), mid: C("#7a4684"), hor: C("#e2663d"), fog: C("#b3536a"), clear: new Color3(0.50, 0.28, 0.34), dir: new Vector3(-0.80, -0.20, 0.20), sun: new Color3(1.00, 0.46, 0.26), sunI: 0.95, hs: new Color3(0.72, 0.56, 0.70), hg: new Color3(0.26, 0.21, 0.26), hi: 0.62, amb: new Color3(0.36, 0.31, 0.40), disc: new Color3(1.00, 0.36, 0.18), sunO: 0.80, moonO: 0.30, starO: 0.45, night: 0.55 },
    { at: 1.00, zen: C("#060a1f"), mid: C("#0e1740"), hor: C("#1b2a55"), fog: C("#16223f"), clear: new Color3(0.05, 0.07, 0.13), dir: new Vector3(-0.32, -0.80, 0.26), sun: new Color3(0.52, 0.62, 0.86), sunI: 0.55, hs: new Color3(0.30, 0.36, 0.56), hg: new Color3(0.13, 0.14, 0.20), hi: 0.50, amb: new Color3(0.22, 0.26, 0.36), disc: new Color3(1.00, 0.40, 0.20), sunO: 0.00, moonO: 0.95, starO: 0.95, night: 1.00 },
  ];
  // Working buffers (reused every frame → zero per-frame allocation).
  const _zen = new Color3(), _mid = new Color3(), _hor = new Color3();
  const _fog = new Color3(), _sunC = new Color3(), _hs = new Color3(), _hg = new Color3(), _amb = new Color3();
  const _disc = new Color3(), _clr = new Color3(), _dir = new Vector3(), _cpos = new Vector3();
  let nightAmt = 0, dayProgress = 0, dayPhase = "day", skyRedrawAccum = 1; // accum=1 → redraw on first tick
  const rgb255 = (col) => "rgb(" + Math.round(col.r * 255) + "," + Math.round(col.g * 255) + "," + Math.round(col.b * 255) + ")";
  const redrawSky = () => {
    const cc = skyTex.getContext();
    const grad = cc.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.00, rgb255(_zen));
    grad.addColorStop(0.50, rgb255(_mid));
    grad.addColorStop(1.00, rgb255(_hor));
    cc.fillStyle = grad; cc.fillRect(0, 0, 8, 256);
    skyTex.update();
  };
  const lerpN = (a, b, f) => a + (b - a) * f;
  // One per-frame pass: compute the cycle param, lerp the surrounding keyframes, and push
  // to lights + sky + celestial bodies + the night neon boost. Cheap (a handful of lerps).
  const applyDayNight = (dtSec) => {
    const elapsedMs = (game && typeof game.elapsed === "number") ? game.elapsed : elapsed * 1000;
    let p = clamp01(elapsedMs / RENEWAL_MS);
    if (game && game.phase === "overtime") p = 1; // overtime locks deep night
    dayProgress = p;
    let i = 0; while (i < DN_KEYS.length - 1 && p > DN_KEYS[i + 1].at) i++;
    const k0 = DN_KEYS[i], k1 = DN_KEYS[Math.min(i + 1, DN_KEYS.length - 1)];
    const f = clamp01((p - k0.at) / ((k1.at - k0.at) || 1));

    Color3.LerpToRef(k0.zen, k1.zen, f, _zen);
    Color3.LerpToRef(k0.mid, k1.mid, f, _mid);
    Color3.LerpToRef(k0.hor, k1.hor, f, _hor);
    Color3.LerpToRef(k0.fog, k1.fog, f, _fog);
    Color3.LerpToRef(k0.sun, k1.sun, f, _sunC);
    Color3.LerpToRef(k0.hs, k1.hs, f, _hs);
    Color3.LerpToRef(k0.hg, k1.hg, f, _hg);
    Color3.LerpToRef(k0.amb, k1.amb, f, _amb);
    Color3.LerpToRef(k0.disc, k1.disc, f, _disc);
    Color3.LerpToRef(k0.clear, k1.clear, f, _clr);
    Vector3.LerpToRef(k0.dir, k1.dir, f, _dir); _dir.normalize();
    nightAmt = lerpN(k0.night, k1.night, f);

    // Directional "sun" light: direction arcs + lowers, colour warms → cools, intensity drops.
    sun.direction.copyFrom(_dir);
    sun.diffuse.copyFrom(_sunC); sun.specular.copyFrom(_sunC);
    sun.intensity = lerpN(k0.sunI, k1.sunI, f);
    // Sky fill + ambient + fog + clear all track the same palette → distance always matches
    // the sky (no mismatched horizon band).
    hemi.diffuse.copyFrom(_hs); hemi.groundColor.copyFrom(_hg);
    hemi.intensity = lerpN(k0.hi, k1.hi, f);
    scene.ambientColor.copyFrom(_amb);
    scene.fogColor.copyFrom(_fog);
    scene.clearColor.set(_clr.r, _clr.g, _clr.b, 1);

    // Sun + moon sit toward the light source (−direction) at SKY_DIST, riding the camera.
    // Sun fades out and reddens toward dusk; moon + stars fade in for night.
    _cpos.copyFrom(_dir).scaleInPlace(-SKY_DIST);
    sunDisc.position.copyFrom(_cpos); moonDisc.position.copyFrom(_cpos);
    sunMat.emissiveColor.copyFrom(_disc);
    sunMat.alpha = lerpN(k0.sunO, k1.sunO, f);
    moonMat.alpha = lerpN(k0.moonO, k1.moonO, f);
    starMat.alpha = lerpN(k0.starO, k1.starO, f);

    // Night neon: brighten every registered emissive (×1 at day, up to ×(1+boost) at night).
    for (let m = 0; m < glowMats.length; m++) {
      const e = glowMats[m]; e.base.scaleToRef(1 + nightAmt * e.boost, e.mat.emissiveColor);
    }

    // Sky-dome gradient: redraw the tiny 8×256 ramp on a throttle (palette moves slowly →
    // ~10 Hz is silky and effectively free; lights/celestial update every frame for smoothness).
    skyRedrawAccum += dtSec;
    if (skyRedrawAccum >= 0.1) { skyRedrawAccum = 0; redrawSky(); }

    dayPhase = p < 0.5 ? "day" : p < 0.78 ? "golden" : p < 0.95 ? "dusk" : "night";
  };

  // ── Per-frame: motes, radar, beacon pulse, gate loom/spin, zone emission. ─────
  let elapsed = 0, curSector = -1, lastFid = -1, disposed = false;

  const tick = (dtArg) => {
    if (disposed) return;
    const fid = typeof scene.getFrameId === "function" ? scene.getFrameId() : lastFid + 1;
    if (fid === lastFid) return; // dedupe whether driven by onFrame or api.update
    lastFid = fid;

    let dt = typeof dtArg === "number" ? dtArg : (engine ? engine.getDeltaTime() / 1000 : 0.016);
    if (!(dt >= 0) || dt > 0.1) dt = 0.05;
    const adt = isPaused() ? 0 : dt;
    elapsed += adt;

    const camZ = camera?.position?.z ?? 0;
    const camX = camera?.position?.x ?? 0;

    // Motes follow the player.
    moteEmitter.position.set(camX, 1, camZ + 8);

    // Day↔night cycle: drives sun/sky/fog/lighting + the night neon boost (nightAmt) used
    // by the animated emissives below. Runs first so nightAmt is current this frame.
    applyDayNight(dt);

    // Radar rings pulse on their sector accent; hands sweep (brighter at night).
    for (let i = 0; i < radarRings.length; i++) {
      const r = radarRings[i];
      const pulse = 0.7 + 0.3 * Math.sin(elapsed * 2.0 + i * 0.9);
      r.base.scaleToRef(pulse * (1 + nightAmt * 1.4), r.mat.emissiveColor);
    }
    for (let i = 0; i < radarSweeps.length; i++) radarSweeps[i].rotation.y += adt * 1.4;

    // Critical account beacons breathe to draw the eye to the highest-stakes targets.
    if (critBeaconMat) BUCKETS[0].c.scaleToRef((0.85 + 0.55 * Math.sin(elapsed * 3.2)) * (1 + nightAmt * 1.6), critBeaconMat.emissiveColor);

    // Renewal Gate: spin rings, pulse core, loom as the player nears (core glows up at night).
    ring1.rotation.y += adt * 0.3; ring2.rotation.y -= adt * 0.5;
    const dist = GATE_Z - camZ;
    const prox = clamp01((LOOM_RANGE - dist) / LOOM_RANGE);
    const gs = 1 + 0.16 * prox; gateRoot.scaling.set(gs, gs, gs);
    const corePulse = (0.55 + 0.35 * Math.sin(elapsed * 2.4)) * (1 + 1.4 * prox) * (1 + nightAmt * 1.3);
    INDIGO_C.scaleToRef(corePulse, gateCoreMat.emissiveColor);
    gateCoreMat.alpha = 0.35 + 0.35 * prox;

    // Emit "zone" on a genuine sector crossing (only while a run is live).
    const idx = sectorOfZ(camZ);
    if (isRunning() && idx !== curSector) { curSector = idx; bus?.emit?.("zone", { name: PAL[curSector].name }); }
  };

  let frameDisposer = null;
  if (typeof ctx.onFrame === "function") { const r = ctx.onFrame(tick); if (typeof r === "function") frameDisposer = r; }
  const onStart = () => { curSector = -1; };
  bus?.on?.("start", onStart);

  // ── Public API ───────────────────────────────────────────────────────────────
  const sectorAt = (z) => {
    const i = sectorOfZ(z || 0);
    const p = PAL[i];
    const progress = clamp01(((z || 0) - i * SECTOR_LEN) / SECTOR_LEN);
    return { index: i, name: p.name, progress, accent: p.accC.clone() };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { if (frameDisposer) frameDisposer(); } catch { /* noop */ }
    try { if (clampObserver) scene.onBeforeRenderObservable.remove(clampObserver); } catch { /* noop */ }
    try { bus?.off?.("start", onStart); } catch { /* noop */ }
    try { motes.dispose(); } catch { /* noop */ }
    try { scene.environmentTexture = null; iblProbe.dispose(); } catch { /* noop */ }
    try { shadowGen.dispose(); } catch { /* noop */ }
    for (const m of meshes) { try { m.dispose(false, false); } catch { /* noop */ } }
    for (const m of mats) { try { m.dispose(true, true); } catch { /* noop */ } }
    for (const t of texes) { try { t.dispose(); } catch { /* noop */ } }
    try { sun.dispose(); } catch { /* noop */ }
    try { hemi.dispose(); } catch { /* noop */ }
  };

  // Perf (Babylon optimize-your-scene): freeze the world matrix of structural meshes
  // that never move so Babylon skips their per-frame transform sync. ALLOWLIST by name —
  // only genuinely-static geometry. Excludes anything animated/moving: the gate (rings
  // rotate, D4 will animate it), celestial bodies (sun/moon/star reposition each frame),
  // and the glowing beacon/band emissives. We freeze world MATRICES only — NOT materials:
  // the day/night cycle pushes per-frame emissive changes into shared materials, so
  // material.freeze()/blockMaterialDirtyMechanism would break the neon night look.
  const STATIC_PREFIXES = [
    "world_ground", "world_hq_", "world_cap_", "world_wall_",
    "world_blk_", "world_park_", "world_parkpath_", "world_plaza_",
    "world_waste_ground", "world_sign_base", "world_grass_blade",
  ];
  for (const m of meshes) {
    const n = m.name || "";
    if (STATIC_PREFIXES.some((p) => n.startsWith(p))) {
      try { m.freezeWorldMatrix(); } catch { /* noop */ }
    }
  }

  // NOTE: freezeShadowCastersBoundingInfo is deliberately NOT set. It would freeze the global
  // caster-bounds recompute (a CPU win), but the Renewal Gate is a shadow caster that scale-pulses
  // up to 1.16× with player proximity (gateRoot.scaling, see tick) — a dynamic caster whose shadow
  // could clip at the frozen box. The win is CPU-side and this scene is GPU-bound, so it's not worth
  // the risk on the hero landmark. Revisit only if profiling shows caster-bounds recompute is hot.

  // C2 — Static physics colliders (only when Havok is on). The player PCC collides/slides
  // against these. Only solid, walkable-against geometry: ground, building bodies, arena
  // walls. Cosmetic slabs/caps/signs are skipped (player never collides with them).
  if (ctx.useHavok && scene.getPhysicsEngine && scene.getPhysicsEngine()) {
    const COLLIDER_PREFIXES = ["world_ground", "world_hq_", "world_wall_"];
    for (const m of meshes) {
      const n = m.name || "";
      if (COLLIDER_PREFIXES.some((p) => n.startsWith(p))) {
        try { new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: 0 }, scene); } catch { /* noop */ }
      }
    }

    // C7 — minimal authored verticality (Havok only) so the PCC's slope-handling and
    // stair step-up actually read (a flat city only exercises wall-slide). A ramp up to a
    // raised plaza + a short stair stack near spawn. SCAFFOLD — reposition during playtest
    // so it sits in open ground, not clipping a block.
    const vMat = track(mats, new StandardMaterial("world_vert_mat", scene));
    vMat.diffuseColor = new Color3(0.42, 0.46, 0.5);
    const vBox = (name, w, h, d, x, y, z, rotX) => {
      const m = track(meshes, MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene));
      m.position.set(x, y, z); if (rotX) m.rotation.x = rotX; m.material = vMat;
      m.isPickable = false; m.receiveShadows = true; m.freezeWorldMatrix();
      try { new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: 0 }, scene); } catch { /* noop */ }
      return m;
    };
    const PX = 26, PZ = 34; // a clear-ish offset from spawn (origin); tune in playtest
    vBox("world_vert_plaza", 16, 2, 16, PX, 1, PZ);                 // raised plaza (top at y=2)
    vBox("world_vert_ramp", 10, 0.6, 14, PX - 12, 1.0, PZ, -0.28);  // ~16° ramp up to it
    for (let i = 0; i < 4; i++) vBox(`world_vert_step_${i}`, 8, 0.45, 1.2, PX + 4, 0.22 + i * 0.45, PZ + 9 + i * 1.2); // stairs
  }

  return {
    update: tick,
    dispose,
    sectorAt,
    worldBounds: { ...BOUNDS },
    // Bonus affordances for collaborators (optional, not required by contract):
    shadowGenerator: shadowGen,
    addShadowCaster: (mesh) => { try { shadowGen.addShadowCaster(mesh); } catch { /* noop */ } },
    gate: gateRoot,
    // Read-only day-night state (e.g. for HUD/audio mood): progress 0→1 over the renewal
    // day (1 in overtime), night 0→1, phase "day"|"golden"|"dusk"|"night".
    timeOfDay: () => ({ progress: dayProgress, night: nightAmt, phase: dayPhase }),
  };

  // ── Local builders (hoisted; closure over scene/track/sharpen/rnd) ────────────

  // Deterministic, tier-matched parody account for a building slot (daily-seed stable).
  function pickAccount(tierIdx) {
    const pool = ACCT_BY_TIER[TIERS[tierIdx].name];
    if (pool && pool.length) return pool[Math.floor(rnd() * pool.length) % pool.length];
    return accountFor(undefined, rnd); // fallback (any account) — shouldn't be reached
  }

  // Shared wordmark material per account (cached → buildings of the same account reuse it).
  function signMaterialFor(acct) {
    const hit = signMatCache.get(acct.name);
    if (hit) return hit;
    const tex = track(texes, wordmarkTexture(acct));
    const mat = track(mats, new StandardMaterial(`world_acctsign_${acct.name}`, scene));
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.diffuseColor = new Color3(1, 1, 1);
    // Keep emissive TINY: fx.js runs a GLOBAL GlowLayer (ignores the bloom threshold and
    // glows any emissive mesh). ~70 sign boards at high emissive would halo into a wash, so
    // signs read via the sun-lit diffuse board; only the health bands/beacons glow → the
    // bucket colour stays the dominant, glowing cue (DESIGN: never shoot Healthy).
    mat.emissiveColor = new Color3(0.08, 0.08, 0.08);
    mat.specularColor = new Color3(0, 0, 0);
    // backFaceCulling TRUE: the sign planes are Mesh.DOUBLESIDE (real front + back facets);
    // culling lets each side draw its own facet. With culling OFF the two coincident
    // transparent quads would double-blend + z-fight. (Only the parody signs use this mat.)
    mat.backFaceCulling = true;
    regGlow(mat, 2.2); // storefront/rooftop wordmarks glow up at night (neon city)
    signMatCache.set(acct.name, mat);
    return mat;
  }

  // Crisp corporate wordmark on a clean board, in the account accent. Panel polarity flips
  // for very light accents so the name always reads (sharp: mipmaps + anisotropy).
  function wordmarkTexture(acct) {
    const W = 512, H = 128;
    const tex = new DynamicTexture(`world_wordmark_${acct.name}`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    const c = tex.getContext();
    c.clearRect(0, 0, W, H);
    const light = hexLum(acct.accent) > 150;        // light accent → dark board for contrast
    const board = light ? "rgba(22,26,34,0.96)" : "rgba(255,255,255,0.96)";
    c.fillStyle = board; roundRect(c, 6, 14, W - 12, H - 28, 18); c.fill();
    c.fillStyle = acct.accent; roundRect(c, 18, 26, 18, H - 52, 8); c.fill(); // accent tab
    c.fillStyle = light ? "#ffffff" : acct.accent;  // wordmark
    c.textBaseline = "middle";
    let fs = 74;
    c.font = `bold ${fs}px Inter, Arial, sans-serif`;
    while (c.measureText(acct.name).width > W - 80 && fs > 26) { fs -= 3; c.font = `bold ${fs}px Inter, Arial, sans-serif`; }
    c.fillText(acct.name, 50, H / 2 + 2);
    tex.update();
    sharpen(tex, 8);
    return tex;
  }

  function hexLum(hex) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function makeSignTexture(title, sub, ink, accent) {
    const W = 512, H = 160;
    const tex = new DynamicTexture(`world_signtex_${title}`, { width: W, height: H }, scene, true);
    tex.hasAlpha = true;
    const c = tex.getContext();
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,0.96)"; roundRect(c, 6, 6, W - 12, H - 12, 16); c.fill();
    c.fillStyle = accent; roundRect(c, 6, 6, 16, H - 12, 8); c.fill();
    c.fillStyle = ink; c.font = "bold 64px Inter, Arial, sans-serif"; c.textBaseline = "middle"; c.fillText(title, 44, 60);
    c.fillStyle = accent; c.font = "600 30px Inter, Arial, sans-serif"; c.fillText(sub, 46, 116);
    tex.update(); sharpen(tex, 4);
    return tex;
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
}
