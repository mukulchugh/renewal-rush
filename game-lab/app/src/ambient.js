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
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

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

  // ── Shared car prototype per colour (body + cabin + 4 wheels → one merged mesh) ──
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
    // Merge into one mesh (paint + wheels keep their materials via multiMaterial). isPickable
    // off so combat raycasts ignore traffic. The merged mesh becomes car #0 of this colour.
    const merged = Mesh.MergeMeshes([body, cabin, ...wheels], true, true, undefined, false, true);
    merged.name = `amb_car_${i}_0`;
    merged.isPickable = false;
    disposables.push(merged, paint);
    return merged;
  };

  const protos = CAR_COLORS.map((c, i) => buildProto(i, c));
  if (protos.some((p) => !p)) return { dispose() {} };
  // Hidden master-mesh pattern: the proto itself never draws (isVisible=false), only its
  // instances do — so there are no stray cars parked at the origin. (setEnabled(false)
  // would also kill the instances; isVisible=false hides only the source's own draw.)
  for (const p of protos) p.isVisible = false;

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
      const node = protos[carN % protos.length].createInstance(`amb_car_${li}_${k}`);
      node.isPickable = false;
      const t = (k + li * 0.37) / (CARS_PER_LANE + 1); // staggered start along the lane
      const z = minZ + (t % 1) * span;
      const speed = SPEED_MIN + ((carN * 37) % 100) / 100 * (SPEED_MAX - SPEED_MIN);
      node.rotation = new Vector3(0, lane.dir > 0 ? 0 : Math.PI, 0);
      node.position.set(lane.x, CAR_Y, z);
      cars.push({ node, dir: lane.dir, speed, z });
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
    for (const car of cars) { try { if (car.node.dispose) car.node.dispose(); } catch { /* noop */ } }
    for (const d of disposables) { try { d.dispose && d.dispose(); } catch { /* noop */ } }
  };

  return { dispose, count: cars.length };
}
