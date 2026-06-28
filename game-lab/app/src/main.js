// main.js — integrator. Wires every module against the ARCHITECTURE.md contract.
// Order matters: pipeline first, controller last (owns the camera each frame),
// fx shake applied after via onBeforeRender. See game-lab/app/ARCHITECTURE.md.
import "@babylonjs/core/Culling/ray"; // MUST be first: makes camera.getForwardRay + scene.pickWithRay real (else _WarnImport stubs)
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Game } from "./game.js";
import { createFx } from "./fx.js";
import { createWorld } from "./world.js";
import { createAudio } from "./audio.js";
import { createHud } from "./hud.js";
import { createBrand } from "./brand.js";
import { createEnemies } from "./enemies.js";
import { createCombat } from "./combat.js";
import { createController } from "./controller.js";
import { createAmbient } from "./ambient.js";
import { createSky } from "./sky.js";
import { createFinish } from "./finish.js";
import { createMeta } from "./meta.js";

const canvas = document.getElementById("game");
// antialias:false on purpose — the DefaultRenderingPipeline renders to an offscreen HDR target and
// resolves edges with FXAA (fx.js), so canvas MSAA is a redundant, wasted resolve every frame.
// powerPreference:"high-performance" → browser picks the discrete GPU on dual-GPU laptops.
const engine = new Engine(canvas, false, { stencil: true, powerPreference: "high-performance" }, true); // FXAA handles AA; adaptToDeviceRatio

const scene = new Scene(engine);
// Perf: combat picks via explicit camera.getForwardRay / scene.pickWithRay — never hover.
// Skip the per-pointer-move scene pick so mouse-look doesn't ray-cast the scene each move.
scene.skipPointerMovePicking = true;

// Camera created BEFORE modules. (0,1.7,0), forward = +Z, aligns with world's +Z layout.
// Do NOT attachControl — controller clears camera inputs and owns look/move + pointer lock.
const camera = new FreeCamera("player", new Vector3(0, 1.7, 0), scene);
camera.rotation.set(0, 0, 0);
camera.minZ = 0.25;
camera.maxZ = 2600;

// Shared flags: PLAIN BOOLEANS + numeric timeScale. fx owns timeScale; controller owns
// locked/invuln/dashing. main must not write timeScale or rebind pointer lock.
const state = { running: true, locked: false, paused: false, timeScale: 1 };

function makeBus() {
  const m = new Map();
  return {
    on(n, fn) { let s = m.get(n); if (!s) { s = new Set(); m.set(n, s); } s.add(fn); return () => s.delete(fn); },
    off(n, fn) { m.get(n)?.delete(fn); },
    emit(n, p) { const s = m.get(n); if (s) for (const fn of [...s]) { try { fn(p); } catch (e) { console.error(e); } } },
  };
}
const bus = makeBus();

const frameCbs = new Set();
const onFrame = (fn) => { frameCbs.add(fn); return () => frameCbs.delete(fn); };

// Daily seed: a stable run-of-the-day (deterministic mutator + spawns). meta.js reads
// ctx.dailySeed for the daily/endless leaderboard; enemies reads game.mutator + game.rng.
const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
let seedNum = 0;
for (let i = 0; i < dateStr.length; i++) seedNum = (seedNum * 31 + dateStr.charCodeAt(i)) >>> 0;

const game = new Game(seedNum);
// metaDraftUI:false → meta.js emits "draft" but does NOT render its own picker; the HUD
// owns the single upgrade-draft overlay (otherwise both render → the draft appears twice).
const ctx = { engine, scene, camera, canvas, game, bus, onFrame, state, dailySeed: dateStr, upgrades: {}, metaDraftUI: false };

// "start" = true restart. hurt -> health, respecting dash i-frames (controller sets state.invuln).
bus.on("start", () => { game.reset(); state.running = true; state.paused = false; });
bus.on("hurt", (e) => { if (!state.invuln) game.takeDamage(e?.amount || 0); });

// ── Havok physics (OPT-IN, default OFF) ──────────────────────────────────────
// Enabled only with ?havok=1 in the URL. We DYNAMIC-import @babylonjs/havok so its
// ~MB WASM stays out of the default bundle and the shipped game keeps its instant,
// physics-free start. When on: PCC-as-resolver controller + Havok ragdolls (C3/C5).
// We disable the scene's auto physics step and drive pe._step(SCALED dt) ourselves so
// dynamic bodies (ragdolls) slow during the shootdodge bullet-time — verified headless:
// pe._step(scaledDelta) gives true t^2 slow-motion (setTimeStep does NOT). See test/physics.test.js.
ctx.useHavok = typeof location !== "undefined" && new URLSearchParams(location.search).has("havok");

// Async boot wrapper: lets us `await` the optional Havok WASM load before module init
// WITHOUT top-level await (kept out so the es2020 build target stays valid). When Havok
// is off this resolves instantly — same behaviour as before.
(async () => {
if (ctx.useHavok) {
  try {
    const [{ default: HavokPhysics }, { HavokPlugin }] = await Promise.all([
      import("@babylonjs/havok"),
      import("@babylonjs/core/Physics/v2/Plugins/havokPlugin"),
      import("@babylonjs/core/Physics/v2/physicsEngineComponent"), // augments Scene.enablePhysics
    ]);
    const havok = await HavokPhysics();
    scene.enablePhysics(new Vector3(0, -22, 0), new HavokPlugin(true, havok));
    scene.physicsEnabled = false; // we step manually (below) with scaled dt for bullet-time
    ctx.physics = scene.getPhysicsEngine();
  } catch (e) {
    console.error("Havok init failed — falling back to hand-rolled controller/ragdolls", e);
    ctx.useHavok = false;
  }
}

// Shared human character model (used by the player avatar + enemies). Visual only — loads
// with or without Havok. If it fails, modules fall back to the procedural primitive rig.
try {
  const [{ LoadAssetContainerAsync }] = await Promise.all([
    import("@babylonjs/core/Loading/sceneLoader"),
    import("@babylonjs/loaders/glTF"), // registers the glTF/GLB loader
  ]);
  // Try each model in order; first that loads wins. Guarantees a TEXTURED human survives one
  // model's load failure (functionality preserved) instead of dropping to ugly primitives.
  // soldier first (the chosen look); xbot is the known-good untextured-but-rigged fallback.
  // Each failure logs the FULL error so a broken model is diagnosable, not silently swallowed.
  const HUMAN_MODELS = ["/models/soldier.glb", "/models/xbot.glb", "/models/human.glb"];
  ctx.humanAsset = null;
  for (const url of HUMAN_MODELS) {
    try {
      ctx.humanAsset = await LoadAssetContainerAsync(url, scene);
      console.log("human model loaded:", url);
      break;
    } catch (e) {
      console.error("human model failed to load:", url, "—", (e && (e.message || e.stack)) || e, e);
    }
  }
  if (!ctx.humanAsset) console.error("all human models failed — using primitive avatars");
  ctx.gunAsset = await LoadAssetContainerAsync("/models/gun.glb", scene).catch(() => null); // Quaternius rifle (CC0)
} catch (e) {
  console.error("human/gun loader init failed — using primitive avatars", e);
  ctx.humanAsset = null;
  ctx.gunAsset = null;
}

// Authored traffic cars (Kenney Car Kit, CC0). Visual only; [] → ambient.js
// falls back to its procedural box cars.
try {
  const { loadCarAssets } = await import("./assets.js");
  ctx.carAssets = await loadCarAssets(scene);
} catch (e) {
  console.error("car models load failed — using procedural traffic", e);
  ctx.carAssets = [];
}

// Init order (ARCHITECTURE.md): fx -> world -> audio -> hud -> brand -> enemies -> combat -> controller.
const step = (name, fn) => {
  try { return fn(); }
  catch (e) {
    console.error("INIT FAIL @ " + name, e);
    (window.__initErr || (window.__initErr = [])).push(name + ": " + (e && e.stack || e));
    return undefined;
  }
};
step("fx", () => createFx(ctx));
ctx.world = step("world", () => createWorld(ctx)); // expose worldBounds/sectorAt to enemies
step("sky", () => createSky(ctx)); // photoreal sky HDRI; retires the procedural dome/sun/moon/stars
step("audio", () => createAudio(ctx));
step("hud", () => createHud(ctx));
ctx.brand = step("brand", () => createBrand(ctx));
step("enemies", () => createEnemies(ctx));
step("ambient", () => createAmbient(ctx)); // decorative street traffic — no game-state coupling
step("finish", () => createFinish(ctx)); // Times Square win-line: Quivly screen + reach-to-win marker
step("combat", () => createCombat(ctx));
step("controller", () => createController(ctx));
// Stickiness layer last: needs ctx.brand (showResult) + must run its Last-Stand timeScale
// re-cap AFTER fx's onFrame (fx is first), so its onFrame registers after fx's.
ctx.meta = step("meta", () => createMeta(ctx));

if (typeof window !== "undefined") window.__rr = { engine, scene, game, state, ctx }; // dev introspection

// Perf instrumentation behind ?perf=1 — measures DEVICE-INDEPENDENT proxies (draw calls,
// active meshes, CPU/GPU frame time) that transfer to real hardware, unlike a raw FPS number
// which is meaningless under software-GL. Dynamic-imported so it never ships in the bundle.
if (typeof window !== "undefined" && /[?&]perf=1\b/.test(location.search)) {
  (async () => {
    // The GPU timer-query methods (engine.captureGPUFrameTime / startTimeQuery) live in a
    // side-effect module that the tree-shaken build doesn't pull in — without it the setter
    // throws "engine.captureGPUFrameTime is not a function". Import it first, then guard in case
    // the EXT_disjoint_timer_query_webgl2 extension is absent (then gpuFrameMs just reads 0).
    await import("@babylonjs/core/Engines/Extensions/engine.query");
    const { SceneInstrumentation } = await import("@babylonjs/core/Instrumentation/sceneInstrumentation");
    const { EngineInstrumentation } = await import("@babylonjs/core/Instrumentation/engineInstrumentation");
    const si = new SceneInstrumentation(scene);
    si.captureActiveMeshesEvaluationTime = true; si.captureFrameTime = true; si.captureRenderTime = true;
    const ei = new EngineInstrumentation(engine);
    let gpuOk = false;
    try { ei.captureGPUFrameTime = true; gpuOk = true; } catch (e) { console.warn("[perf] GPU timer unavailable — gpuFrameMs will read 0", e); }
    const snap = () => ({
      fps: +engine.getFps().toFixed(1),
      drawCalls: si.drawCallsCounter.current,
      activeMeshes: scene.getActiveMeshes().length,
      totalMeshes: scene.meshes.length,
      textures: scene.textures.length,
      cpuFrameMs: +si.frameTimeCounter.lastSecAverage.toFixed(2),
      gpuFrameMs: gpuOk ? +(ei.gpuFrameTimeCounter.lastSecAverage / 1e6).toFixed(2) : 0, // ns→ms; 0 if timer ext absent
      hwScale: engine.getHardwareScalingLevel(),
    });
    window.__rr.perf = snap;
    let acc = 0;
    onFrame(() => { acc++; if (acc % 120 === 0) console.log("[perf]", JSON.stringify(snap())); });
    console.log("[perf] instrumentation on — window.__rr.perf() for a snapshot");
  })();
}

let prevStatus = game.status;
engine.runRenderLoop(() => {
  const raw = engine.getDeltaTime(); // ms
  const ts = state.paused ? 0 : (state.timeScale ?? 1);
  const dtMs = raw * ts;
  const dtSec = dtMs / 1000;

  if (state.running && !state.paused) game.tick(dtMs); // advance renewal clock

  if (game.status !== prevStatus) { // emit win/lose ONCE at true run end
    prevStatus = game.status;
    if (game.status === "lost") {
      // Two-act model: game only ever ends as "lost" (health 0, or renewal<40). If the
      // renewal was already banked (overtime death), it's still a WIN. Else churn.
      state.running = false;
      bus.emit(game.wonRenewal ? "win" : "lose");
    } else if (game.status === "won") { // legacy safety; game.js no longer sets this
      state.running = false; bus.emit("win");
    }
  }

  // Step Havok dynamic bodies (ragdolls) with the SCALED dt so they slow in bullet-time.
  // dtSec is already raw*timeScale (0 while paused → frozen). Clamp to avoid hitch blow-ups.
  if (ctx.physics) { try { ctx.physics._step(Math.min(dtSec, 0.05)); } catch (e) { console.error(e); } }

  for (const fn of frameCbs) { try { fn(dtSec); } catch (e) { console.error(e); } }
  scene.render();
});

addEventListener("resize", () => engine.resize());

// Robustness: auto-pause when the tab is backgrounded (otherwise rAF throttles and the
// next visible frame's getDeltaTime is huge → everything teleports) or when the WebGL
// context is lost (Babylon auto-rebuilds GL resources on restore; we just pause/resume).
// We track OUR OWN pause via autoPaused so we never clobber a HUD modal pause.
let autoPaused = false;
const autoPause = () => { if (!state.paused) { state.paused = true; autoPaused = true; } };
const autoResume = () => { if (autoPaused) { state.paused = false; autoPaused = false; } };
addEventListener("visibilitychange", () => { if (document.hidden) autoPause(); else autoResume(); });
addEventListener("blur", autoPause);
addEventListener("focus", autoResume);
engine.onContextLostObservable.add(autoPause);
engine.onContextRestoredObservable.add(autoResume);

bus.emit("start");
})();
