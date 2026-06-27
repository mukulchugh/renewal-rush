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
import { createMeta } from "./meta.js";

const canvas = document.getElementById("game");
const engine = new Engine(canvas, true, { stencil: true }, true); // antialias + adaptToDeviceRatio

const scene = new Scene(engine);

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
const ctx = { engine, scene, camera, canvas, game, bus, onFrame, state, dailySeed: dateStr, upgrades: {} };

// "start" = true restart. hurt -> health, respecting dash i-frames (controller sets state.invuln).
bus.on("start", () => { game.reset(); state.running = true; state.paused = false; });
bus.on("hurt", (e) => { if (!state.invuln) game.takeDamage(e?.amount || 0); });

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
step("audio", () => createAudio(ctx));
step("hud", () => createHud(ctx));
ctx.brand = step("brand", () => createBrand(ctx));
step("enemies", () => createEnemies(ctx));
step("combat", () => createCombat(ctx));
step("controller", () => createController(ctx));
// Stickiness layer last: needs ctx.brand (showResult) + must run its Last-Stand timeScale
// re-cap AFTER fx's onFrame (fx is first), so its onFrame registers after fx's.
ctx.meta = step("meta", () => createMeta(ctx));

if (typeof window !== "undefined") window.__rr = { engine, scene, game, state, ctx }; // dev introspection

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

  for (const fn of frameCbs) { try { fn(dtSec); } catch (e) { console.error(e); } }
  scene.render();
});

addEventListener("resize", () => engine.resize());
bus.emit("start");
