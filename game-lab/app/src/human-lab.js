// human-lab.js — isolated validation of the real-human + Havok-ragdoll pipeline.
// Open /human-lab.html on a GPU. Proves, before touching the pooled enemy system:
//   1. a rigged glTF human loads + plays its walk animation,
//   2. Havok physics initialises,
//   3. Babylon's Ragdoll (per-bone physics bodies) goes dynamic on demand.
// Press R (or click) to drop the human into a ragdoll. Press space to reset.
//
// CesiumMan is the placeholder human (Khronos sample, CC-BY 4.0 — swap for a CC0 model
// later). Its 19 joints are listed below; the ragdoll box sizes are the one thing to tune
// by eye once this renders.

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3, Color3 } from "@babylonjs/core/Maths/math";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType, PhysicsConstraintType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Ragdoll } from "@babylonjs/core/Physics/v2/ragdoll";
import "@babylonjs/core/Physics/physicsEngineComponent";
import "@babylonjs/loaders/glTF"; // registers the glTF/GLB loader
import HavokPhysics from "@babylonjs/havok";

// Per-bone ragdoll config (box collider + joint per CesiumMan joint). Sizes are in model
// units — TUNE THESE by eye once it renders; bad sizes = floating/clipping boxes.
const BAS = PhysicsConstraintType.BALL_AND_SOCKET;
const RAGDOLL_CONFIG = [
  { bone: "Skeleton_torso_joint_1", size: 0.5, joint: BAS },
  { bone: "Skeleton_torso_joint_2", size: 0.45, joint: BAS },
  { bone: "torso_joint_3", size: 0.4, joint: BAS },
  { bone: "Skeleton_neck_joint_1", size: 0.28, joint: BAS },
  { bone: "Skeleton_neck_joint_2", size: 0.26, joint: BAS },
  { bone: "Skeleton_arm_joint_L__4_", size: 0.2, joint: BAS },
  { bone: "Skeleton_arm_joint_L__3_", size: 0.18, joint: BAS },
  { bone: "Skeleton_arm_joint_L__2_", size: 0.16, joint: BAS },
  { bone: "Skeleton_arm_joint_R", size: 0.2, joint: BAS },
  { bone: "Skeleton_arm_joint_R__2_", size: 0.18, joint: BAS },
  { bone: "Skeleton_arm_joint_R__3_", size: 0.16, joint: BAS },
  { bone: "leg_joint_L_1", size: 0.24, joint: BAS },
  { bone: "leg_joint_L_2", size: 0.22, joint: BAS },
  { bone: "leg_joint_L_3", size: 0.2, joint: BAS },
  { bone: "leg_joint_L_5", size: 0.18, joint: BAS },
  { bone: "leg_joint_R_1", size: 0.24, joint: BAS },
  { bone: "leg_joint_R_2", size: 0.22, joint: BAS },
  { bone: "leg_joint_R_3", size: 0.2, joint: BAS },
  { bone: "leg_joint_R_5", size: 0.18, joint: BAS },
];

const log = (m) => {
  const el = document.getElementById("status");
  if (el) el.textContent = m;
  console.log("[human-lab]", m);
};

async function main() {
  const canvas = document.getElementById("c");
  const engine = new Engine(canvas, true, { stencil: true });
  const scene = new Scene(engine);
  scene.clearColor = Color3.FromHexString("#0b0d10").toColor4(1);

  const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.6, 6, new Vector3(0, 1, 0), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 30;
  new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 0.7;
  const dir = new DirectionalLight("d", new Vector3(-0.5, -1, -0.5), scene); dir.intensity = 0.8;

  const groundMat = new StandardMaterial("gm", scene);
  groundMat.diffuseColor = Color3.FromHexString("#1b2733");
  const ground = MeshBuilder.CreateGround("ground", { width: 30, height: 30 }, scene);
  ground.material = groundMat;

  log("loading Havok…");
  const havok = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  log("loading human.glb…");
  const result = await ImportMeshAsync("/models/human.glb", scene);
  const root = result.meshes[0];
  const skeleton = result.skeletons[0];
  root.scaling.setAll(1);
  // CesiumMan imports facing +Z lying along its own axes; stand it up at origin.
  root.position.set(0, 0, 0);

  // Play the walk animation (the single unnamed group).
  const walk = result.animationGroups[0];
  if (walk) { walk.start(true, 1.0, walk.from, walk.to, false); log("walking — press R to ragdoll, Space to reset"); }
  else log("loaded (no animation group found) — press R to ragdoll");

  // Build (kinematic) ragdoll now; flip to dynamic on demand.
  let ragdoll = null;
  function buildRagdoll() {
    try {
      ragdoll = new Ragdoll(skeleton, root, RAGDOLL_CONFIG);
      log("ragdoll built (kinematic) — press R to drop");
    } catch (e) {
      log("ragdoll build FAILED: " + e.message);
      console.error(e);
    }
  }
  buildRagdoll();

  function drop() {
    if (!ragdoll) return;
    if (walk) walk.stop();
    try { ragdoll.ragdoll(); log("RAGDOLL dynamic — Space to reset"); }
    catch (e) { log("ragdoll() FAILED: " + e.message); console.error(e); }
  }
  function reset() { window.location.reload(); }

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") drop();
    if (e.key === " ") reset();
  });
  canvas.addEventListener("click", drop);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

main().catch((e) => { log("FATAL: " + e.message); console.error(e); });
