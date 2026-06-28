// combat.js — "Agent Pulse" agent-deployer for Renewal Rush.
//
// You are a deployed Quivly AI agent. Left-click DEPLOYS an agent onto the churn
// SIGNAL under your crosshair (a clean indigo deploy pulse). "E" fires the Agent
// Pulse: a real-ray cone that deploys onto every signal in front of you at once.
//
// Brand law (QUIVLY-GROUNDING.md): this is a DEPLOY TOOL, not a gun. The viewmodel
// is a premium handheld deployer device — matte shell, an indigo emissive core/coil,
// a glowing emitter lens, a holo-sight — that LAUNCHES agents. Keep the FPS feel.
//
// Contract (ARCHITECTURE.md): combat NEVER scores. It only raycasts and relays the
// hit through `mesh.metadata.onHit(damage)`. enemies.js is the SOLE scorer + the sole
// emitter of kill/combo/hitHealthy/escape. We emit only "fire" and "pulse" (audio.js
// + fx.js consume them). Per-frame work is registered via ctx.onFrame.
//
// Deep ESM imports only (tree-shakeable). Importing "@babylonjs/core/Culling/ray" is
// load-bearing: it runs AddRayExtensions(Scene, Camera), which is what makes
// camera.getForwardRay() and scene.pickWithRay() exist at all (else _WarnImport("Ray")).
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Ray } from "@babylonjs/core/Culling/ray";

const TAU = Math.PI * 2;

// --- Weapon tuning (combat-owned; ARR/health/combo numbers come from game.js) ---
const DAMAGE = 34; // per primary deploy pulse
const RANGE = 90; // primary reach
const FIRE_INTERVAL = 0.11; // s between primary deploys (fire-rate cap + auto-fire)

const AOE_DAMAGE = 64; // per pulse beam (one-shots most signals)
const AOE_RANGE = 34; // pulse radius
const AOE_COOLDOWN = 6.0; // s between Agent Pulses
const AOE_HALF_ANGLE = 0.42; // rad (~24deg) cone half-angle, sampled by real rays
// Concentric rings of sample rays. Outer rings carry more rays for even angular
// coverage. Casting these rays IS the cone — no dot-product membership test.
const AOE_RINGS = [
  { count: 1, ang: 0.0, phase: 0 },
  { count: 7, ang: AOE_HALF_ANGLE * 0.42, phase: 0.0 },
  { count: 12, ang: AOE_HALF_ANGLE * 0.72, phase: 0.26 },
  { count: 16, ang: AOE_HALF_ANGLE * 1.0, phase: 0.52 },
];

// --- STYLE / "Loco" meter (announcer + JUICE ONLY; never touches ARR scoring) ---
// enemies.js + game.js own all scoring. This is a parallel, decaying "stylishness"
// score that drives the announcer + extra screen punch. We read the "kill" bus event
// (which enemies emits) but never emit "kill" ourselves.
const STYLE_BASE = 12; // points per neutralize
const STYLE_AIR = 45; // bonus for a kill made mid-shootdodge ("AIR KILL")
const STYLE_RAPID = 18; // bonus for a kill within RAPID_WINDOW of the previous one
const STYLE_RAPID_WINDOW = 0.9; // s — back-to-back kill window
const STYLE_FULLSTACK = 14; // bonus per EXTRA source (chips-1) on a multi-source kill
const STYLE_BOSS = 60;
const STYLE_CHAMPION = 30;
const STYLE_CAP = 320;
const STYLE_GRACE = 0.9; // s of no-kill before the meter starts to bleed
const STYLE_DECAY = 120; // points/sec bled after the grace (full bar gone in <3s)
// rank thresholds (points) → name + an announcer-flavored multiplier (NOT applied to ARR)
const STYLE_RANKS = [
  { at: 0, rank: "", mult: 1.0 },
  { at: 20, rank: "COOL", mult: 1.25 },
  { at: 80, rank: "HOT", mult: 1.5 },
  { at: 170, rank: "LOCO", mult: 2.0 },
  { at: 280, rank: "OVERDOSE", mult: 3.0 },
];

const TRACER_COUNT = 24; // two-layer beams (core + halo)
const IMPACT_COUNT = 20; // spark pops
const RING_COUNT = 12; // expanding "deployed" shockwave rings

const _UP = Vector3.UpReadOnly;

export function createCombat(ctx) {
  const { engine, scene, camera, canvas, game, bus } = ctx;
  const state = ctx.state || {};

  // ---- brand palette (numeric to avoid any hex-parse API surface) ----
  const COL = {
    indigo: new Color3(0.388, 0.4, 0.945), // #6366F1
    indigoLt: new Color3(0.647, 0.706, 0.988), // #A5B4FC
    cyan: new Color3(0.133, 0.827, 0.933), // #22D3EE
    mint: new Color3(0.204, 0.827, 0.6), // #34D399 (resolved / ARR saved)
    warn: new Color3(0.984, 0.749, 0.141), // #FBBF24 (boss)
    risk: new Color3(0.973, 0.443, 0.443), // #F87171 (false positive)
    white: new Color3(0.92, 0.94, 1.0),
  };

  let disposed = false;
  let mouseDown = false;
  let primaryCd = 0;
  let aoeCd = 0;
  let _lastRid = -1;

  // style meter (juice/announcer only)
  let stylePts = 0;
  let styleRankIdx = 0;
  let lastKillT = -999;

  // ---------- flag helpers (state.x may be a getter fn or a plain bool) ----------
  const flag = (name, dflt) => {
    const v = state[name];
    const r = typeof v === "function" ? v() : v;
    return r === undefined || r === null ? dflt : !!r;
  };
  const isRunning = () => flag("running", true);
  const isPaused = () => flag("paused", false);
  const isLocked = () => {
    const v = state.locked;
    const r = typeof v === "function" ? v() : v;
    if (r !== undefined && r !== null) return !!r;
    return typeof document !== "undefined" && document.pointerLockElement === canvas;
  };

  // only ever pick things that can actually be deployed onto
  const isTarget = (m) => !!(m && m.metadata && typeof m.metadata.onHit === "function");

  // The viewmodel renders in renderingGroupId 1 (its own pass, depth cleared) so it
  // never clips into walls. Still tighten the near plane a touch in case a sway/kick
  // brings the emitter toward the eye. Only ever lowers minZ (never raises it).
  if (typeof camera.minZ === "number") camera.minZ = Math.min(camera.minZ || 1, 0.2);

  // ============================================================================
  //  VIEWMODEL — a premium handheld "Agent Pulse" deployer (multi-part).
  //  Everything parents to a root TransformNode so recoil / sway / idle-bob are a
  //  single clean transform. Shell + metal are PBR (premium, lit by the world sun);
  //  the core/coil/lens are unlit emissive so the GlowLayer blooms them as indigo neon.
  // ============================================================================
  const REST = { x: 0.3, y: -0.26, z: 0.9 };
  const REST_ROT = { x: -0.035, y: -0.16, z: 0.02 };

  const root = new TransformNode("apulse_root", scene);
  root.parent = camera;
  root.position.set(REST.x, REST.y, REST.z);
  root.rotation.set(REST_ROT.x, REST_ROT.y, REST_ROT.z);

  const vmMeshes = [];
  const vmMats = [];
  const trackMesh = (m) => {
    m.parent = root;
    m.isPickable = false;
    m.renderingGroupId = 1; // viewmodel pass: always drawn on top of the world
    vmMeshes.push(m);
    return m;
  };
  const trackMat = (m) => {
    vmMats.push(m);
    return m;
  };

  // ---- materials ----
  // Matte graphite shell — low metallic so it reads bright under the daylight sun
  // even though the scene has no env texture (look comes from direct lights).
  const shellMat = trackMat(new PBRMaterial("apulse_shell", scene));
  shellMat.albedoColor = new Color3(0.12, 0.13, 0.17);
  shellMat.metallic = 0.28;
  shellMat.roughness = 0.46;
  shellMat.environmentIntensity = 0.4;
  shellMat.emissiveColor = new Color3(0.02, 0.02, 0.045); // never crush to pure black

  // Brushed-aluminium accents (collars, deck, sight posts).
  const metalMat = trackMat(new PBRMaterial("apulse_metal", scene));
  metalMat.albedoColor = new Color3(0.6, 0.64, 0.71);
  metalMat.metallic = 0.4;
  metalMat.roughness = 0.38;
  metalMat.environmentIntensity = 0.5;

  // Dark vents / seams.
  const darkMat = trackMat(new StandardMaterial("apulse_dark", scene));
  darkMat.diffuseColor = new Color3(0.03, 0.03, 0.04);
  darkMat.specularColor = new Color3(0.05, 0.05, 0.07);

  // Indigo energy core / coil (unlit emissive → GlowLayer bloom). Animated.
  const coilMat = trackMat(new StandardMaterial("apulse_coil", scene));
  coilMat.disableLighting = true;
  coilMat.emissiveColor = COL.indigo.clone();

  // Emitter lens + ring (brighter; flares on fire). Animated.
  const lensMat = trackMat(new StandardMaterial("apulse_lens", scene));
  lensMat.disableLighting = true;
  lensMat.emissiveColor = COL.indigoLt.clone();

  // Holo-sight reticle (cyan).
  const sightMat = trackMat(new StandardMaterial("apulse_sight", scene));
  sightMat.disableLighting = true;
  sightMat.emissiveColor = COL.cyan.clone();

  // Three status pips (deploy-ready indicators) — animated individually.
  const pipMats = [0, 1, 2].map((i) => {
    const m = trackMat(new StandardMaterial("apulse_pip" + i, scene));
    m.disableLighting = true;
    m.emissiveColor = COL.indigo.clone();
    return m;
  });

  // ---- geometry ----
  // Shell: a rounded capsule body laid along local +Z (rounded = premium, not a box).
  const shell = trackMesh(
    MeshBuilder.CreateCapsule("apulse_body", { radius: 0.078, height: 0.36, tessellation: 18, capSubdivisions: 6 }, scene)
  );
  shell.rotation.x = Math.PI / 2; // capsule axis Y -> lay along Z
  shell.position.set(0, 0, 0.0);
  shell.material = shellMat;

  // Underside spine strip — a thin emissive power line along the belly.
  const spine = trackMesh(MeshBuilder.CreateBox("apulse_spine", { width: 0.018, height: 0.012, depth: 0.3 }, scene));
  spine.position.set(0, -0.066, 0.0);
  spine.material = coilMat;

  // Energy coil: three glowing rings wrapped around the mid-body.
  const coilZ = [-0.04, 0.02, 0.08];
  for (let i = 0; i < coilZ.length; i++) {
    const ringMesh = trackMesh(
      MeshBuilder.CreateTorus("apulse_coil" + i, { diameter: 0.172, thickness: 0.014, tessellation: 26 }, scene)
    );
    ringMesh.rotation.x = Math.PI / 2; // wrap around the Z axis of the body
    ringMesh.position.set(0, 0, coilZ[i]);
    ringMesh.material = coilMat;
  }

  // Brushed collar where the emitter assembly meets the body.
  const collar = trackMesh(
    MeshBuilder.CreateCylinder("apulse_collar", { height: 0.05, diameterTop: 0.13, diameterBottom: 0.165, tessellation: 24 }, scene)
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0, 0.2);
  collar.material = metalMat;

  // Emitter ring (glowing rim of the aperture).
  const emitterRing = trackMesh(
    MeshBuilder.CreateTorus("apulse_emit_ring", { diameter: 0.122, thickness: 0.02, tessellation: 32 }, scene)
  );
  emitterRing.rotation.x = Math.PI / 2;
  emitterRing.position.set(0, 0, 0.27);
  emitterRing.material = lensMat;

  // Emitter lens — a domed disc of light at the muzzle (the deploy aperture).
  const lens = trackMesh(MeshBuilder.CreateSphere("apulse_lens", { diameter: 0.108, segments: 14 }, scene));
  lens.scaling.set(1, 1, 0.42); // flatten into a dome
  lens.position.set(0, 0, 0.285);
  lens.material = lensMat;

  // Top control deck — a low rounded slab carrying the sight + status pips.
  const deck = trackMesh(MeshBuilder.CreateBox("apulse_deck", { width: 0.085, height: 0.026, depth: 0.24 }, scene));
  deck.position.set(0, 0.07, -0.02);
  deck.material = metalMat;

  // Holo-sight: two posts + a glowing vertical reticle bar.
  const postL = trackMesh(MeshBuilder.CreateBox("apulse_postL", { width: 0.012, height: 0.05, depth: 0.012 }, scene));
  postL.position.set(-0.026, 0.105, 0.12);
  postL.material = metalMat;
  const postR = trackMesh(MeshBuilder.CreateBox("apulse_postR", { width: 0.012, height: 0.05, depth: 0.012 }, scene));
  postR.position.set(0.026, 0.105, 0.12);
  postR.material = metalMat;
  const reticle = trackMesh(MeshBuilder.CreateBox("apulse_reticle", { width: 0.006, height: 0.046, depth: 0.006 }, scene));
  reticle.position.set(0, 0.108, 0.12);
  reticle.material = sightMat;

  // Status pips on the deck (light up as the Agent Pulse recharges).
  const pipZ = [-0.08, -0.03, 0.02];
  const pipMeshes = [];
  for (let i = 0; i < 3; i++) {
    const pip = trackMesh(MeshBuilder.CreateBox("apulse_pip" + i, { width: 0.016, height: 0.01, depth: 0.016 }, scene));
    pip.position.set(0, 0.088, pipZ[i]);
    pip.material = pipMats[i];
    pipMeshes.push(pip);
  }

  // Side vents — subtle detail.
  for (let i = 0; i < 3; i++) {
    const vent = trackMesh(MeshBuilder.CreateBox("apulse_vent" + i, { width: 0.005, height: 0.03, depth: 0.05 }, scene));
    vent.position.set(0.072, 0.0, -0.02 + i * 0.045);
    vent.material = darkMat;
  }

  // Grip: a capsule angled down/back at the rear (handheld silhouette).
  const grip = trackMesh(
    MeshBuilder.CreateCapsule("apulse_grip", { radius: 0.042, height: 0.18, tessellation: 14, capSubdivisions: 4 }, scene)
  );
  grip.rotation.x = 0.42; // tilt back
  grip.position.set(0, -0.13, -0.13);
  grip.material = shellMat;

  // Activation band near the top of the grip (where the thumb deploys).
  const gripBand = trackMesh(
    MeshBuilder.CreateTorus("apulse_gripband", { diameter: 0.09, thickness: 0.012, tessellation: 18 }, scene)
  );
  gripBand.rotation.x = Math.PI / 2 + 0.42;
  gripBand.position.set(0, -0.085, -0.105);
  gripBand.material = coilMat;

  // ---- emitter flash + light (muzzle / aperture flare) ----
  const EMIT_LOCAL = new Vector3(0, 0.0, 0.33);

  const flashMat = trackMat(new StandardMaterial("apulse_flash", scene));
  flashMat.disableLighting = true;
  flashMat.emissiveColor = COL.indigoLt.clone();
  flashMat.alpha = 0;
  flashMat.backFaceCulling = false;
  const flash = trackMesh(MeshBuilder.CreatePlane("apulse_muzzle", { size: 0.46 }, scene));
  flash.position.copyFrom(EMIT_LOCAL);
  flash.billboardMode = 7; // BILLBOARDMODE_ALL
  flash.material = flashMat;
  flash.setEnabled(false);
  let flashLife = 0;
  let flashMax = 0.06;

  const muzzleLight = new PointLight("apulse_light", EMIT_LOCAL.clone(), scene);
  muzzleLight.parent = root;
  muzzleLight.diffuse = COL.indigoLt.clone();
  muzzleLight.specular = COL.indigo.clone();
  muzzleLight.range = 9;
  muzzleLight.intensity = 0;

  // ---- recoil / sway / idle state (all viewmodel-local; never touch the camera) ----
  let kickZ = 0; // pushed back toward the eye
  let kickPitch = 0; // muzzle climb
  let kickRoll = 0; // small character roll
  let kickYaw = 0;
  let swayX = 0; // weapon lags the look (trailing inertia)
  let swayY = 0;
  let prevYaw = camera.rotation ? camera.rotation.y : 0;
  let prevPitch = camera.rotation ? camera.rotation.x : 0;
  let holster = 0; // 0 = up/ready, 1 = lowered (when unlocked / paused / not running)
  let vmTime = 0;
  let fireGlow = 0; // emissive flare on the lens/coil, decays after each deploy

  // ============================================================================
  //  BEAM / IMPACT POOLS  (world-space, renderingGroupId 0)
  // ============================================================================

  // Two-layer deploy beam: a bright thin core + a soft wide halo, both unlit emissive.
  const tracers = [];
  for (let i = 0; i < TRACER_COUNT; i++) {
    const coreMat = new StandardMaterial("trc_c" + i, scene);
    coreMat.disableLighting = true;
    coreMat.emissiveColor = COL.indigo.clone();
    coreMat.alpha = 0;
    const haloMat = new StandardMaterial("trc_h" + i, scene);
    haloMat.disableLighting = true;
    haloMat.emissiveColor = COL.indigo.clone();
    haloMat.alpha = 0;
    haloMat.backFaceCulling = false;
    const core = MeshBuilder.CreateCylinder("trcc_" + i, { height: 1, diameter: 1, tessellation: 6 }, scene);
    core.material = coreMat;
    core.isPickable = false;
    core.rotationQuaternion = Quaternion.Identity();
    core.setEnabled(false);
    const halo = MeshBuilder.CreateCylinder("trch_" + i, { height: 1, diameter: 1, tessellation: 8 }, scene);
    halo.material = haloMat;
    halo.isPickable = false;
    halo.rotationQuaternion = Quaternion.Identity();
    halo.setEnabled(false);
    tracers.push({ core, coreMat, halo, haloMat, base: COL.indigo, life: 0, maxLife: 1, active: false });
  }
  let trcIdx = 0;

  // Impact spark — a bright sphere that pops and fades.
  const impacts = [];
  for (let i = 0; i < IMPACT_COUNT; i++) {
    const mat = new StandardMaterial("imp_" + i, scene);
    mat.disableLighting = true;
    mat.emissiveColor = COL.indigo.clone();
    mat.alpha = 0;
    const mesh = MeshBuilder.CreateSphere("impm_" + i, { diameter: 1, segments: 8 }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.setEnabled(false);
    impacts.push({ mesh, mat, base: COL.indigo, life: 0, maxLife: 1, from: 0.14, active: false });
  }
  let impIdx = 0;

  // "Agent deployed" shockwave — an expanding glowing ring on a neutralize.
  const rings = [];
  for (let i = 0; i < RING_COUNT; i++) {
    const mat = new StandardMaterial("rng_" + i, scene);
    mat.disableLighting = true;
    mat.emissiveColor = COL.mint.clone();
    mat.alpha = 0;
    mat.backFaceCulling = false;
    const mesh = MeshBuilder.CreateTorus("rngm_" + i, { diameter: 1, thickness: 0.06, tessellation: 28 }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.billboardMode = 7; // face the player
    mesh.setEnabled(false);
    rings.push({ mesh, mat, base: COL.mint, life: 0, maxLife: 1, to: 2, active: false });
  }
  let ringIdx = 0;

  // ============================================================================
  //  geometry helpers
  // ============================================================================
  function alignY(mesh, d) {
    // orient a cylinder's local +Y axis along unit direction d
    let axis = Vector3.Cross(_UP, d);
    const l = axis.length();
    if (l < 1e-5) {
      Quaternion.RotationAxisToRef(Vector3.RightReadOnly, d.y < 0 ? Math.PI : 0, mesh.rotationQuaternion);
      return;
    }
    axis.scaleInPlace(1 / l);
    const dot = Math.min(1, Math.max(-1, Vector3.Dot(_UP, d)));
    Quaternion.RotationAxisToRef(axis, Math.acos(dot), mesh.rotationQuaternion);
  }

  function muzzleWorld(o, f, r, u) {
    // approx world-space emitter tip from the camera basis (no world-matrix recompute).
    // tuned to the lower-right deployer pose so the beam reads as leaving the lens.
    return o.add(f.scale(0.95)).addInPlace(r.scale(0.28)).subtractInPlace(u.scale(0.18));
  }

  function basis(dir) {
    let right = Vector3.Cross(_UP, dir);
    if (right.length() < 1e-4) right = Vector3.RightReadOnly.clone();
    right.normalize();
    const up = Vector3.Cross(dir, right);
    up.normalize();
    return { right, up };
  }

  // ============================================================================
  //  fx spawners
  // ============================================================================
  function spawnTracer(start, end, color, coreThick, lifeSec) {
    const delta = end.subtract(start);
    const len = delta.length();
    if (len < 1e-4) return;
    const d = delta.scaleInPlace(1 / len);
    const t = tracers[trcIdx];
    trcIdx = (trcIdx + 1) % tracers.length;
    const mid = start.add(d.scale(len * 0.5));
    t.core.position.copyFrom(mid);
    t.halo.position.copyFrom(mid);
    alignY(t.core, d);
    alignY(t.halo, d);
    t.core.scaling.set(coreThick, len, coreThick);
    t.halo.scaling.set(coreThick * 3.2, len, coreThick * 3.2);
    t.base = color;
    t.coreMat.emissiveColor.copyFrom(COL.white).scaleInPlace(0.6).addInPlace(color);
    t.haloMat.emissiveColor.copyFrom(color);
    t.coreMat.alpha = 1;
    t.haloMat.alpha = 0.4;
    t.life = lifeSec;
    t.maxLife = lifeSec;
    t.active = true;
    t.core.setEnabled(true);
    t.halo.setEnabled(true);
  }

  function spawnImpact(point, color, size) {
    const s = impacts[impIdx];
    impIdx = (impIdx + 1) % impacts.length;
    s.from = size || 0.14;
    s.mesh.position.copyFrom(point);
    s.mesh.scaling.setAll(s.from);
    s.base = color;
    s.mat.emissiveColor.copyFrom(color);
    s.mat.alpha = 1;
    s.life = 0.24;
    s.maxLife = 0.24;
    s.active = true;
    s.mesh.setEnabled(true);
  }

  function spawnRing(point, color, maxDiameter, lifeSec) {
    const r = rings[ringIdx];
    ringIdx = (ringIdx + 1) % rings.length;
    r.to = maxDiameter;
    r.mesh.position.copyFrom(point);
    r.mesh.scaling.setAll(0.2);
    r.base = color;
    r.mat.emissiveColor.copyFrom(color);
    r.mat.alpha = 0.9;
    r.life = lifeSec;
    r.maxLife = lifeSec;
    r.active = true;
    r.mesh.setEnabled(true);
  }

  function emitterFlash(strength) {
    const hot = strength > 1.5;
    flash.setEnabled(true);
    flash.scaling.setAll(0.3 * strength * (0.8 + Math.random() * 0.5));
    flash.rotation.z = Math.random() * TAU;
    flashMat.emissiveColor.copyFrom(hot ? COL.cyan : COL.indigoLt);
    flashMat.alpha = 1;
    flashMax = 0.05 + 0.03 * strength;
    flashLife = flashMax;
    muzzleLight.diffuse.copyFrom(hot ? COL.cyan : COL.indigoLt);
    muzzleLight.intensity = 6 * strength;
    fireGlow = Math.min(2.2, fireGlow + 0.7 * strength);
  }

  function kick(z, pitch) {
    kickZ += z;
    kickPitch += pitch;
    kickRoll += (Math.random() - 0.5) * pitch * 0.6;
    kickYaw += (Math.random() - 0.5) * pitch * 0.4;
  }

  // ============================================================================
  //  hit resolution — combat ONLY raycasts + relays. enemies.js scores.
  //   • color the spark by the target's kind (healthy → red false-positive sting).
  //   • `dead` (onHit's return) ONLY scales feedback intensity — never used to score
  //     and never used to infer "healthy" (a damaged-not-dead signal also returns false).
  //   • do NOT emit "kill"; enemies.js owns that (and fx.js juices it).
  // ============================================================================
  function impactColor(kind) {
    if (kind === "healthy") return COL.risk;
    if (kind === "boss") return COL.warn;
    if (kind === "churn") return COL.cyan;
    return COL.indigo;
  }

  function handleHit(mesh, dmg, point) {
    const meta = mesh && mesh.metadata;
    if (!meta || typeof meta.onHit !== "function") return;
    const kind = meta.kind || "signal";
    const p = point ? point.clone() : mesh.getAbsolutePosition().clone();
    let dead = false;
    try {
      dead = !!meta.onHit(dmg);
    } catch (_) {}

    spawnImpact(p, impactColor(kind), dead ? 0.22 : 0.12);

    if (dead && kind !== "healthy") {
      // A signal was NEUTRALIZED — the agent resolved the risk. Satisfying ripple:
      // a green "deployed / ARR saved" shockwave (gold for a boss renewal).
      const ringCol = kind === "boss" ? COL.warn : COL.mint;
      spawnRing(p, ringCol, kind === "boss" ? 3.2 : 2.0, kind === "boss" ? 0.42 : 0.3);
      spawnImpact(p, ringCol, 0.18);
    }
  }

  // ============================================================================
  //  firing
  // ============================================================================
  function firePrimary() {
    if (disposed || primaryCd > 0) return;
    if (!isLocked() || !isRunning() || isPaused()) return;
    primaryCd = FIRE_INTERVAL;
    bus?.emit?.("fire");
    emitterFlash(1.0);
    kick(0.05, 0.05); // recoil carried by the viewmodel kick (no fov fight w/ controller)

    const fr = camera.getForwardRay(RANGE);
    const origin = fr.origin;
    const dir = fr.direction;
    const { right, up } = basis(dir);
    const muzzle = muzzleWorld(origin, dir, right, up);

    const pick = scene.pickWithRay(fr, isTarget);
    const hitOk = pick && pick.hit && pick.pickedPoint && pick.distance <= RANGE;
    const end = hitOk ? pick.pickedPoint : origin.add(dir.scale(RANGE));
    spawnTracer(muzzle, end, COL.indigo, 0.022, 0.085);

    if (hitOk && pick.pickedMesh) handleHit(pick.pickedMesh, DAMAGE, pick.pickedPoint);
  }

  function firePulse() {
    if (disposed || aoeCd > 0) return;
    if (!isLocked() || !isRunning() || isPaused()) return;
    aoeCd = AOE_COOLDOWN;
    bus?.emit?.("pulse");
    emitterFlash(2.4);
    kick(0.12, 0.11);
    // One-shot FOV punch (6s cooldown → fully recovers): add an impulse and let the
    // controller's per-frame fov easing pull it back. We never write fov absolutely.
    if (typeof camera.fov === "number") camera.fov += 0.05;

    const fr = camera.getForwardRay(AOE_RANGE);
    const origin = fr.origin;
    const fwd = fr.direction;
    const { right, up } = basis(fwd);
    const muzzle = muzzleWorld(origin, fwd, right, up);

    // fan real rays through the cone; dedupe by mesh so each target is hit once
    const found = new Map();
    for (const ring of AOE_RINGS) {
      const a = ring.ang;
      for (let i = 0; i < ring.count; i++) {
        let dir;
        if (a === 0) {
          dir = fwd.clone();
        } else {
          const theta = (i / ring.count) * TAU + ring.phase;
          const perp = right.scale(Math.cos(theta)).addInPlace(up.scale(Math.sin(theta)));
          dir = fwd.scale(Math.cos(a)).addInPlace(perp.scaleInPlace(Math.sin(a)));
          dir.normalize();
        }
        const ray = new Ray(origin.clone(), dir, AOE_RANGE);
        const pick = scene.pickWithRay(ray, isTarget);
        if (pick && pick.hit && pick.pickedMesh && pick.distance <= AOE_RANGE) {
          const id = pick.pickedMesh.uniqueId;
          if (!found.has(id)) found.set(id, { mesh: pick.pickedMesh, point: pick.pickedPoint.clone() });
        }
      }
    }

    if (found.size === 0) {
      // visible feedback even on a whiff: a swept fan of soft cyan beams + a charge ring
      for (let i = 0; i < 5; i++) {
        const a = (i / 5 - 0.4) * AOE_HALF_ANGLE * 1.6;
        const perp = right.scale(Math.sin(a));
        const d = fwd.scale(Math.cos(a)).addInPlace(perp);
        d.normalize();
        spawnTracer(muzzle, origin.add(d.scale(AOE_RANGE)), COL.cyan, 0.03, 0.12);
      }
      spawnRing(muzzle, COL.cyan, 2.4, 0.32);
      return;
    }
    for (const { mesh, point } of found.values()) {
      spawnTracer(muzzle, point, COL.cyan, 0.04, 0.15);
      handleHit(mesh, AOE_DAMAGE, point);
    }
  }

  // ============================================================================
  //  STYLE meter (juice/announcer ONLY — combat never scores; enemies.js owns ARR)
  // ============================================================================
  function rankIdxFor(pts) {
    let idx = 0;
    for (let i = 0; i < STYLE_RANKS.length; i++) if (pts >= STYLE_RANKS[i].at) idx = i;
    return idx;
  }

  // Driven by the "kill" bus event (emitted by enemies.js). Builds the rolling style
  // score, emits "style" {rank,mult,points} for the HUD meter + "announce" barks on
  // rank-ups and notable kills, and adds extra explosive feel on air / big / high kills.
  function onStyleKill(p) {
    if (disposed || !p) return;
    const t = vmTime;
    const dv = state.diving;
    const air = !!(typeof dv === "function" ? dv() : dv);
    const chips = (p.chips | 0) || 1;
    const boss = p.kind === "boss";
    const champion = !!p.champion;

    let add = STYLE_BASE;
    if (air) add += STYLE_AIR;
    if (t - lastKillT <= STYLE_RAPID_WINDOW) add += STYLE_RAPID; // back-to-back
    if (chips > 1) add += STYLE_FULLSTACK * (chips - 1); // Full-Stack multi-source
    if (boss) add += STYLE_BOSS;
    if (champion) add += STYLE_CHAMPION;
    lastKillT = t;

    stylePts = Math.min(STYLE_CAP, stylePts + add);
    const newIdx = rankIdxFor(stylePts);
    const rankUp = newIdx > styleRankIdx;
    styleRankIdx = newIdx;
    const r = STYLE_RANKS[styleRankIdx];

    // meter update (HUD/audio bind this): rank name, announcer mult, raw points.
    bus?.emit?.("style", { rank: r.rank, mult: r.mult, points: Math.round(stylePts) });

    // announcer barks (juice only): rank-ups, plus notable single kills.
    if (rankUp && r.rank) {
      const tone = r.rank === "OVERDOSE" ? "overdose" : "style";
      bus?.emit?.("announce", { text: r.rank + "!", tone });
    }
    if (air) bus?.emit?.("announce", { text: "AIR KILL", tone: "style" });
    else if (chips >= 3) bus?.emit?.("announce", { text: "FULL STACK", tone: "focus" });

    // explosive feel: layer extra fx + a bonus shockwave on air / boss / LOCO+ kills.
    // We DON'T emit "kill" (enemies owns it) — fx.js already juices the base kill; this
    // is additive punch for the over-the-top moments.
    const big = air || boss || styleRankIdx >= 3;
    if (big && p.position) {
      const col = boss ? COL.warn : air ? COL.cyan : COL.mint;
      spawnRing(p.position, col, boss ? 4.0 : 3.0, 0.4);
      spawnImpact(p.position, col, 0.26);
      const fx = ctx.fx;
      if (fx) {
        fx.shake && fx.shake(air ? 0.34 : 0.24);
        if (styleRankIdx >= 4 && fx.flash) fx.flash("#FBBF24", 0.16); // OVERDOSE pop
      }
    }
  }

  // ============================================================================
  //  per-frame
  // ============================================================================
  function tick(dt) {
    if (disposed) return;
    // Third-person: the player avatar carries its own deploy-tool, so hide the camera-anchored
    // FPS viewmodel (it would float behind the avatar). state.playerPos is only set in TPS.
    // World-space tracers still render (their origin is computed from the camera basis, not root).
    const tps = !!(ctx.state && ctx.state.playerPos);
    if (root.isEnabled() === tps) root.setEnabled(!tps);
    // dedupe in case the caller also calls api.update() in the same frame
    const rid = scene.getRenderId ? scene.getRenderId() : 0;
    if (rid === _lastRid && rid !== 0) return;
    _lastRid = rid;

    dt = typeof dt === "number" && dt > 0 ? dt : (engine.getDeltaTime ? engine.getDeltaTime() : 16) / 1000;
    if (dt > 0.05) dt = 0.05;
    // REAL wall-clock dt: the fire cadence must run at full speed even while the world
    // is in slow-mo (shootdodge), so you can actually unload mid-dive (DESIGN §0b). dt
    // above is scaled by main's timeScale; realDt is not.
    let realDt = (engine.getDeltaTime ? engine.getDeltaTime() : 16) / 1000;
    if (realDt > 0.05) realDt = 0.05;
    vmTime += realDt; // animation/style timers in wall-clock so slow-mo doesn't stall them

    if (primaryCd > 0) primaryCd -= realDt; // fire-rate is real-time (decoupled from slow-mo)
    if (aoeCd > 0) aoeCd -= dt; // pulse cooldown stays gameplay-time (a balance cost)

    // style meter bleed: after a grace with no kills, drift back down. On a rank DROP,
    // push a quiet style update so the HUD meter tracks (no announce on the way down).
    if (stylePts > 0 && !isPaused() && vmTime - lastKillT > STYLE_GRACE) {
      stylePts = Math.max(0, stylePts - STYLE_DECAY * realDt);
      const idx = rankIdxFor(stylePts);
      if (idx !== styleRankIdx) {
        styleRankIdx = idx;
        const r = STYLE_RANKS[styleRankIdx];
        bus?.emit?.("style", { rank: r.rank, mult: r.mult, points: Math.round(stylePts) });
      }
    }

    if (mouseDown && primaryCd <= 0 && isRunning() && isLocked() && !isPaused()) firePrimary();

    // --- beams (two-layer fade) ---
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i];
      if (!t.active) continue;
      t.life -= dt;
      const k = t.life > 0 ? t.life / t.maxLife : 0;
      t.coreMat.alpha = k;
      t.haloMat.alpha = 0.4 * k;
      t.coreMat.emissiveColor.copyFrom(t.base).scaleInPlace(0.5 + 0.7 * k).addInPlace(COL.white.scale(0.35 * k));
      t.haloMat.emissiveColor.copyFrom(t.base).scaleInPlace(0.3 + 0.5 * k);
      if (t.life <= 0) {
        t.active = false;
        t.core.setEnabled(false);
        t.halo.setEnabled(false);
      }
    }

    // --- impact sparks (expand + fade) ---
    for (let i = 0; i < impacts.length; i++) {
      const s = impacts[i];
      if (!s.active) continue;
      s.life -= dt;
      const k = s.life > 0 ? s.life / s.maxLife : 0;
      s.mat.alpha = k;
      s.mesh.scaling.setAll(s.from + (1 - k) * 0.55);
      if (s.life <= 0) {
        s.active = false;
        s.mesh.setEnabled(false);
      }
    }

    // --- deployed shockwave rings (expand + fade) ---
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (!r.active) continue;
      r.life -= dt;
      const k = r.life > 0 ? r.life / r.maxLife : 0;
      const e = 1 - k * k; // ease-out expansion
      r.mat.alpha = 0.9 * k;
      r.mesh.scaling.setAll(0.2 + e * r.to);
      r.mat.emissiveColor.copyFrom(r.base).scaleInPlace(0.6 + 0.8 * k);
      if (r.life <= 0) {
        r.active = false;
        r.mesh.setEnabled(false);
      }
    }

    // --- emitter flash + light decay ---
    if (flashLife > 0) {
      flashLife -= dt;
      const k = flashLife > 0 ? flashLife / flashMax : 0;
      flashMat.alpha = k;
      muzzleLight.intensity = muzzleLight.intensity * Math.max(0, 1 - dt * 16);
      if (flashLife <= 0) {
        flash.setEnabled(false);
        muzzleLight.intensity = 0;
      }
    }

    // --- viewmodel: recoil + look-sway + idle bob + holster (all local) ---
    const decay = Math.min(1, dt * 14);
    kickZ -= kickZ * decay;
    kickPitch -= kickPitch * decay;
    kickRoll -= kickRoll * decay;
    kickYaw -= kickYaw * decay;
    if (fireGlow > 0) fireGlow = Math.max(0, fireGlow - dt * 6);

    // weapon trails the look (inertia), reads as weight
    if (camera.rotation) {
      let dyaw = camera.rotation.y - prevYaw;
      if (dyaw > Math.PI) dyaw -= TAU;
      else if (dyaw < -Math.PI) dyaw += TAU;
      const dpitch = camera.rotation.x - prevPitch;
      prevYaw = camera.rotation.y;
      prevPitch = camera.rotation.x;
      const ease = Math.min(1, dt * 9);
      swayX += (-dyaw * 0.9 - swayX) * ease;
      swayY += (-dpitch * 0.7 - swayY) * ease;
      swayX = Math.max(-0.06, Math.min(0.06, swayX));
      swayY = Math.max(-0.06, Math.min(0.06, swayY));
    }

    // holster down when not actively playing
    const down = !isLocked() || !isRunning() || isPaused();
    holster += ((down ? 1 : 0) - holster) * Math.min(1, dt * 8);

    const bobY = Math.sin(vmTime * 1.7) * 0.0035;
    const bobX = Math.sin(vmTime * 0.95) * 0.0025;

    root.position.x = REST.x + bobX + swayX * 0.6;
    root.position.y = REST.y + bobY + swayY * 0.5 + kickZ * 0.16 - holster * 0.22;
    root.position.z = REST.z - kickZ + holster * 0.05;
    root.rotation.x = REST_ROT.x - kickPitch + swayY * 0.5 + holster * 0.55;
    root.rotation.y = REST_ROT.y + kickYaw + swayX * 0.35;
    root.rotation.z = REST_ROT.z + kickRoll + swayX * 0.9;

    // --- emissive animation: core/coil/lens/pips reflect Agent-Pulse charge ---
    const readyFrac = 1 - Math.min(1, Math.max(0, aoeCd / AOE_COOLDOWN));
    const pulse = 0.5 + 0.5 * Math.sin(vmTime * 3.2);

    const coilI = (0.55 + 0.3 * pulse) * (0.45 + 0.55 * readyFrac) + fireGlow * 0.5;
    coilMat.emissiveColor.copyFrom(COL.indigo).scaleInPlace(coilI);

    const lensCol = readyFrac > 0.999 ? COL.cyan : COL.indigoLt;
    const lensI = 0.9 + 0.35 * pulse + fireGlow * 1.1;
    lensMat.emissiveColor.copyFrom(lensCol).scaleInPlace(lensI);

    sightMat.emissiveColor.copyFrom(COL.cyan).scaleInPlace(0.7 + 0.3 * pulse);

    for (let i = 0; i < pipMats.length; i++) {
      const on = readyFrac >= (i + 0.5) / 3;
      if (on) pipMats[i].emissiveColor.copyFrom(COL.mint).scaleInPlace(0.9 + 0.4 * pulse);
      else pipMats[i].emissiveColor.copyFrom(COL.indigo).scaleInPlace(0.12);
    }
  }

  // ============================================================================
  //  input
  // ============================================================================
  function onPointerDown(e) {
    if (disposed || e.button !== 0) return;
    if (!isLocked() || !isRunning() || isPaused()) return;
    mouseDown = true;
    if (primaryCd <= 0) firePrimary(); // first shot instant, then auto-fire
  }
  function onPointerUp(e) {
    if (e.button === 0) mouseDown = false;
  }
  function onKeyDown(e) {
    if (disposed) return;
    const k = e.code || e.key;
    if (k === "KeyE" || k === "e" || k === "E") firePulse();
  }
  function onLockChange() {
    if (!isLocked()) mouseDown = false;
  }
  function onBlur() {
    mouseDown = false;
  }

  const startHandler = () => {
    primaryCd = 0;
    aoeCd = 0;
    stylePts = 0;
    styleRankIdx = 0;
    lastKillT = -999;
  };
  bus?.on?.("start", startHandler);
  bus?.on?.("kill", onStyleKill);

  canvas?.addEventListener?.("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", onBlur);
  if (typeof document !== "undefined") document.addEventListener("pointerlockchange", onLockChange);

  ctx.onFrame?.(tick);

  // ============================================================================
  //  public api
  // ============================================================================
  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas?.removeEventListener?.("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", onBlur);
    if (typeof document !== "undefined") document.removeEventListener("pointerlockchange", onLockChange);
    bus?.off?.("start", startHandler);
    bus?.off?.("kill", onStyleKill);
    // NOTE: we never wrote camera.fov absolutely, so nothing to restore (controller owns it).

    for (const t of tracers) {
      t.core.dispose();
      t.coreMat.dispose();
      t.halo.dispose();
      t.haloMat.dispose();
    }
    for (const s of impacts) {
      s.mesh.dispose();
      s.mat.dispose();
    }
    for (const r of rings) {
      r.mesh.dispose();
      r.mat.dispose();
    }
    muzzleLight.dispose();
    for (const m of vmMeshes) {
      try {
        m.dispose();
      } catch (_) {}
    }
    for (const m of vmMats) {
      try {
        m.dispose();
      } catch (_) {}
    }
    try {
      root.dispose();
    } catch (_) {}
  }

  return {
    update: tick, // optional; per-frame work is already driven via ctx.onFrame
    dispose,
    // small introspection surface (handy for a HUD cooldown ring)
    get aoeCooldown() {
      return Math.max(0, aoeCd);
    },
    get aoeReady() {
      return aoeCd <= 0;
    },
    firePrimary,
    firePulse,
  };
}