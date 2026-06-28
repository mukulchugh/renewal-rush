// ambient.js — decorative street life (the "open city is alive" layer). Cars cruise
// the boulevard + side roads on simple rails. PURELY cosmetic: they never fight, never
// touch game state, never end a run — so the time-attack loop is untouched, the streets
// just stop feeling empty. Pooled instances + one shared material per colour = cheap.
//
// Contract (ARCHITECTURE.md): createAmbient(ctx) registers per-frame work via ctx.onFrame.
//
// ponytail: traffic only (v1). Cars pass through the player (decorative, no collision) —
// add a soft shove via the player pos if it ever reads wrong. Pedestrians are the next
// slice (reuse ctx.humanAsset + spawnHuman like enemies do); not built yet.

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

// Target world length (Z) of a car — matches the old box car so lane spacing,
// speeds, and the building-free road centres all stay tuned.
const CAR_LEN = 4.4;
// If authored cars drive tail-first, bump by Math.PI. Auto-orientation already
// aligns the model's longest horizontal axis to the lane; this only flips front/back.
const CAR_FACE_YAW = 0;

// World-space bounding box over a node's meshes (after its world matrix is current).
function measureExtent(node) {
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of node.getChildMeshes(false)) {
    if (!m.getBoundingInfo) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  }
  if (!isFinite(min.x)) return null;
  return { min, dx: max.x - min.x, dy: max.y - min.y, dz: max.z - min.z };
}

const CAR_COLORS = [
  new Color3(0.62, 0.10, 0.12), // deep red
  new Color3(0.85, 0.86, 0.90), // white
  new Color3(0.10, 0.13, 0.20), // near-black
  new Color3(0.16, 0.34, 0.52), // steel blue
];

// Lanes: { x, dir } — cars run along +Z (dir 1) or −Z (dir −1) at this x. The boulevard
// (x=0, wide) gets two opposing lanes; the side roads at ±70/±140 get one each. All road
// centres are building-free by construction, so cars never clip a tower.
const LANES = [
  { x: -5, dir: 1 }, { x: 5, dir: -1 },   // central boulevard, both ways
  { x: -70, dir: 1 }, { x: 70, dir: -1 }, // side streets
  { x: -140, dir: -1 }, { x: 140, dir: 1 },
];

const CARS_PER_LANE = 2;       // total ≈ 12 cars — alive, not gridlocked
const SPEED_MIN = 9, SPEED_MAX = 15; // u/s — brisk city traffic
const CAR_Y = 0.0;             // wheels sit on the road

export function createAmbient(ctx) {
  const { scene, onFrame } = ctx;
  const bounds = (ctx.world && ctx.world.worldBounds) || { minZ: -8, maxZ: 382 };
  const minZ = bounds.minZ + 4, maxZ = bounds.maxZ - 4, span = maxZ - minZ;
  if (span <= 0) return { dispose() {} };

  const disposables = [];
  let disposed = false;

  // Authored car GLBs (Kenney Car Kit, CC0) when present, else procedural boxes.
  const carAssets = (ctx.carAssets && ctx.carAssets.length) ? ctx.carAssets : null;

  // makeCar(idx, name) → { node, baseYaw, footY, inst? } | null. baseYaw aligns the
  // model down the lane (length onto +Z); footY drops the wheels onto the road.
  let makeCar;

  if (carAssets) {
    makeCar = (idx, name) => {
      const asset = carAssets[idx % carAssets.length];
      const inst = asset.instantiateModelsToScene(undefined, false); // share materials = cheap
      const root = inst.rootNodes[0];
      if (!root) { try { inst.dispose(); } catch { /* noop */ } return null; }
      // Wrap in our own holder so the glTF import transform (units/handedness) stays intact.
      const holder = new TransformNode(name, scene);
      root.parent = holder;
      holder.rotation.setAll(0); holder.scaling.setAll(1); holder.position.setAll(0);
      holder.computeWorldMatrix(true);
      const ext = measureExtent(holder);
      if (!ext) { try { holder.dispose(); inst.dispose(); } catch { /* noop */ } return null; }
      const s = CAR_LEN / Math.max(0.01, Math.max(ext.dx, ext.dz)); // fit length to CAR_LEN
      holder.scaling.setAll(s);
      const baseYaw = ext.dx > ext.dz ? Math.PI / 2 : 0; // model length on X → rotate onto Z
      for (const m of holder.getChildMeshes(false)) m.isPickable = false; // combat ignores traffic
      return { node: holder, inst, baseYaw, footY: -ext.min.y * s };
    };
  } else {
    // ── Procedural fallback: one merged box car per colour (the original look) ──
    const wheelMat = new StandardMaterial("amb_wheel_mat", scene);
    wheelMat.diffuseColor = new Color3(0.04, 0.04, 0.05); wheelMat.specularColor = new Color3(0, 0, 0);
    disposables.push(wheelMat);

    const buildProto = (i, color) => {
      const body = MeshBuilder.CreateBox(`amb_proto_body_${i}`, { width: 2.0, height: 0.85, depth: 4.4 }, scene);
      body.position.y = 0.75;
      const cabin = MeshBuilder.CreateBox(`amb_proto_cabin_${i}`, { width: 1.7, height: 0.78, depth: 2.3 }, scene);
      cabin.position.set(0, 1.42, -0.25);
      const paint = new PBRMaterial(`amb_paint_${i}`, scene);
      paint.albedoColor = color; paint.metallic = 0.55; paint.roughness = 0.28; paint.environmentIntensity = 1.0; // catches IBL + SSR → reflective car bodies
      body.material = paint; cabin.material = paint;
      const wheels = [];
      for (const [wx, wz] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) {
        const w = MeshBuilder.CreateCylinder(`amb_proto_wheel_${i}`, { height: 0.35, diameter: 0.8, tessellation: 10 }, scene);
        w.rotation.z = Math.PI / 2; w.position.set(wx, 0.4, wz); w.material = wheelMat;
        wheels.push(w);
      }
      const merged = Mesh.MergeMeshes([body, cabin, ...wheels], true, true, undefined, false, true);
      merged.name = `amb_car_${i}_0`;
      merged.isPickable = false;
      disposables.push(merged, paint);
      return merged;
    };

    const protos = CAR_COLORS.map((c, i) => buildProto(i, c));
    if (protos.some((p) => !p)) return { dispose() {} };
    for (const p of protos) p.isVisible = false; // master never draws; only its instances do
    makeCar = (idx, name) => {
      const node = protos[idx % protos.length].createInstance(name);
      node.isPickable = false;
      return { node, baseYaw: 0, footY: CAR_Y };
    };
  }

  // ── Spawn cars across lanes, spaced out along Z ─────────────────────────────────
  // ponytail: no per-car shadow caster — instance shadows under an invisible CSM source
  // is a finicky path for marginal gain on fast-moving distant traffic. Add if they float.
  const cars = [];
  let carN = 0;
  // Vary speed by index so lanes don't move in lockstep (RNG-free → keeps the determinism
  // guarantees the rest of the game relies on).
  for (let li = 0; li < LANES.length; li++) {
    const lane = LANES[li];
    for (let k = 0; k < CARS_PER_LANE; k++) {
      const made = makeCar(carN, `amb_car_${li}_${k}`);
      if (!made) { carN++; continue; } // bad model instance → skip, keep the rest
      const { node, baseYaw, footY, inst } = made;
      const t = (k + li * 0.37) / (CARS_PER_LANE + 1); // staggered start along the lane
      const z = minZ + (t % 1) * span;
      const speed = SPEED_MIN + ((carN * 37) % 100) / 100 * (SPEED_MAX - SPEED_MIN);
      const dirYaw = lane.dir > 0 ? 0 : Math.PI;
      node.rotation = new Vector3(0, baseYaw + dirYaw + CAR_FACE_YAW, 0);
      node.position.set(lane.x, footY, z);
      cars.push({ node, inst, dir: lane.dir, speed, z });
      carN++;
    }
  }

  // ── Per-frame: advance along Z, wrap at the far end ─────────────────────────────
  const tick = (dt) => {
    if (disposed || !dt) return;
    for (const car of cars) {
      car.z += car.dir * car.speed * dt;
      if (car.z > maxZ) car.z = minZ; else if (car.z < minZ) car.z = maxZ;
      car.node.position.z = car.z;
    }
  };
  const offFrame = onFrame ? onFrame(tick) : null;

  const dispose = () => {
    if (disposed) return; disposed = true;
    try { offFrame && offFrame(); } catch { /* noop */ }
    for (const car of cars) {
      try { if (car.inst && car.inst.dispose) car.inst.dispose(); } catch { /* noop */ }
      try { if (car.node && car.node.dispose) car.node.dispose(); } catch { /* noop */ }
    }
    for (const d of disposables) { try { d.dispose && d.dispose(); } catch { /* noop */ } }
  };

  return { dispose, count: cars.length };
}
