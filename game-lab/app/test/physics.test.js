// Headless Havok physics checks — the verifiable backbone of Phase C (Havok is CPU/WASM,
// independent of WebGL, so these run without a GPU). They lock in the two mechanisms the
// flagged Havok controller/ragdolls depend on:
//   1. PhysicsCharacterController.integrate advances position from setVelocity (C3 core).
//   2. pe._step(SCALED delta) gives real slow-motion → ragdolls slow in bullet-time (C4).
//      (setTimeStep does NOT slow the sim — verified during the spike; that's why main.js
//      drives pe._step(scaledDt) manually instead of using the scene's raw auto-step.)
// If Havok can't load in this environment, the suite SKIPS rather than fails.
import { test } from "node:test";
import assert from "node:assert/strict";

let havok, NullEngine, Scene, Vector3, MeshBuilder, HavokPlugin, PhysicsAggregate, PhysicsShapeType, PhysicsCharacterController;
try {
  ({ default: havok } = await import("@babylonjs/havok").then(async (m) => ({ default: await m.default() })));
  ({ NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js"));
  ({ Scene } = await import("@babylonjs/core/scene.js"));
  ({ Vector3 } = await import("@babylonjs/core/Maths/math.vector.js"));
  ({ MeshBuilder } = await import("@babylonjs/core/Meshes/meshBuilder.js"));
  ({ HavokPlugin } = await import("@babylonjs/core/Physics/v2/Plugins/havokPlugin.js"));
  await import("@babylonjs/core/Physics/v2/physicsEngineComponent.js"); // Scene.enablePhysics
  ({ PhysicsAggregate } = await import("@babylonjs/core/Physics/v2/physicsAggregate.js"));
  ({ PhysicsShapeType } = await import("@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js"));
  ({ PhysicsCharacterController } = await import("@babylonjs/core/Physics/v2/characterController.js"));
} catch (e) {
  console.warn("Havok unavailable — skipping physics tests:", e?.message || e);
}

const ready = !!havok;

function makeScene() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -10, 0), new HavokPlugin(true, havok));
  return scene;
}

test("C3: PhysicsCharacterController.integrate advances position from setVelocity", { skip: !ready }, () => {
  const scene = makeScene();
  const cc = new PhysicsCharacterController(new Vector3(0, 5, 0), { capsuleHeight: 1.8, capsuleRadius: 0.6 }, scene);
  const DOWN = new Vector3(0, -1, 0);
  for (let i = 0; i < 20; i++) {
    const support = cc.checkSupport(1 / 60, DOWN);
    cc.setVelocity(new Vector3(3, 0, 0)); // 3 m/s +x
    cc.integrate(1 / 60, support, new Vector3(0, -10, 0));
  }
  const p = cc.getPosition();
  // 3 m/s * 20 frames * (1/60)s = 1.0 unit
  assert.ok(Math.abs(p.x - 1.0) < 0.25, `expected x≈1.0, got ${p.x.toFixed(3)}`);
});

test("C4: pe._step(scaledDelta) slows the sim (bullet-time mechanism)", { skip: !ready }, () => {
  const scene = makeScene();
  const pe = scene.getPhysicsEngine();
  const fall = (frames, deltaPerFrame) => {
    const m = MeshBuilder.CreateSphere("s", { diameter: 1 }, scene);
    m.position.set(0, 100, 0); m.computeWorldMatrix(true);
    const a = new PhysicsAggregate(m, PhysicsShapeType.SPHERE, { mass: 1 }, scene);
    for (let i = 0; i < frames; i++) pe._step(deltaPerFrame);
    const dropped = 100 - m.position.y;
    a.dispose(); m.dispose();
    return dropped;
  };
  const normal = fall(30, 1 / 60);        // 0.5s of sim  → ~1.25 units (0.5*g*t^2)
  const slow = fall(30, (1 / 60) * 0.2);  // 0.1s of sim  → ~0.05 units
  assert.ok(normal > 0.8 && normal < 2.0, `normal-speed fall off: ${normal.toFixed(3)}`);
  assert.ok(slow < normal * 0.2, `bullet-time did not slow the sim: slow=${slow.toFixed(3)} normal=${normal.toFixed(3)}`);
});
