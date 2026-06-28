// Headless tests for the Yuka steering layer (no Babylon needed). Run: bun test / node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNavMesh, pathPoints, createEnemyAI } from "../src/enemyai.js";

const inside = (p, b) => p.x > b.minx && p.x < b.maxx && p.z > b.minz && p.z < b.maxz;

test("navmesh routes a path AROUND a blocked building cell", () => {
  // 3×3 grid (cell 10) with the center cell blocked. A straight line corner→corner crosses
  // the center; the path must detour through the open edge cells.
  const bounds = { minX: 0, maxX: 30, minZ: 0, maxZ: 30 };
  const block = { cx: 15, cz: 15, r: 3, minx: 12, maxx: 18, minz: 12, maxz: 18 };
  const navMesh = buildNavMesh(bounds, [block], { cell: 10, margin: 0.5 });
  assert.ok(navMesh, "navmesh should build from a 3×3 grid with one hole");

  const path = pathPoints(navMesh, 5, 5, 25, 25);
  assert.ok(path && path.length >= 2, "a route corner→corner should exist");
  for (const p of path) assert.ok(!inside(p, block), `waypoint ${p.x},${p.z} must avoid the building`);
});

test("buildNavMesh returns null when the grid is degenerate", () => {
  // Whole area covered by one footprint → no walkable cells → null (caller falls back).
  const nm = buildNavMesh({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    [{ minx: -5, maxx: 15, minz: -5, maxz: 15 }], { cell: 10, margin: 0 });
  assert.equal(nm, null);
});

test("an agent steers toward its Arrive target over time", () => {
  const ai = createEnemyAI({ bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, footprints: [] });
  const a = ai.addAgent(0, 0, { maxSpeed: 6, maxForce: 20 });
  a.setTarget(20, 0);
  const start = a.vehicle.position.x;
  for (let i = 0; i < 120; i++) ai.update(1 / 60); // ~2s
  assert.ok(a.vehicle.position.x > start + 5, `agent should move toward x=20 (got ${a.vehicle.position.x.toFixed(2)})`);
  assert.ok(Math.abs(a.vehicle.position.z) < 3, "should stay roughly on the z=0 line");
});

test("agent handle surface used by enemies.js works (path / maxSpeed / remove)", () => {
  const ai = createEnemyAI({ bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, footprints: [] });
  const a = ai.addAgent(0, 0, { maxSpeed: 5, maxForce: 20 });

  a.setMaxSpeed(2);
  assert.equal(a.vehicle.maxSpeed, 2);

  // setPath activates FollowPath + makes the agent travel along it.
  assert.equal(a.setPath([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }]), true);
  assert.ok(a.onPath(), "should be following a path");
  a.setMaxSpeed(6);
  for (let i = 0; i < 180; i++) ai.update(1 / 60);
  assert.ok(a.vehicle.position.x > 4, "agent should advance along the path");

  // null path clears FollowPath and re-enables Arrive.
  assert.equal(a.setPath(null), false);
  assert.equal(a.onPath(), false);

  // remove() detaches from the manager (handoff to ragdoll/Havok on death).
  a.remove();
  assert.equal(ai.manager.entities.includes(a.vehicle), false);
});

test("separation pushes two stacked agents apart", () => {
  const ai = createEnemyAI({ bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, footprints: [] });
  const a = ai.addAgent(0, 0, { sepRadius: 3, sepWeight: 3 });
  const b = ai.addAgent(0.4, 0, { sepRadius: 3, sepWeight: 3 });
  a.setTarget(0, 0); b.setTarget(0, 0); // both want the same spot
  for (let i = 0; i < 120; i++) ai.update(1 / 60);
  const dx = a.vehicle.position.x - b.vehicle.position.x;
  const dz = a.vehicle.position.z - b.vehicle.position.z;
  assert.ok(Math.hypot(dx, dz) > 0.8, "stacked agents should separate");
});
