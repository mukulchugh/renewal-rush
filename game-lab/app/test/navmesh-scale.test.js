// Real-scale navmesh check: reconstruct Renewal Rush's actual road grid + building lines
// (world.js V_ROADS/H_ROADS/ROAD_HW) and confirm the navmesh STAYS CONNECTED at production
// cell/margin — i.e. the "route around buildings" feature actually has a graph to route on.
// Guards the exact failure mode the design smells: margin inflation sealing road corridors,
// which would make pathTo() return null and silently fall back to beelining.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNavMesh, pathPoints } from "../src/enemyai.js";

// ── faithful reconstruction of the city footprints (matches world.js placement) ──
const ROAD_HW = 6, BLVD_HW = 16;
const V_ROADS = [
  { cx: -140, hw: ROAD_HW }, { cx: -70, hw: ROAD_HW }, { cx: 0, hw: BLVD_HW },
  { cx: 70, hw: ROAD_HW }, { cx: 140, hw: ROAD_HW },
];
const H_ROADS = [-6, 42, 90, 138, 186, 234, 282, 330, 378];
const BOUNDS = { minX: -148, maxX: 148, minZ: -8, maxZ: 382 };

function cityFootprints() {
  const cols = [];
  for (let i = 0; i < V_ROADS.length - 1; i++) {
    const x0 = V_ROADS[i].cx + V_ROADS[i].hw;
    const x1 = V_ROADS[i + 1].cx - V_ROADS[i + 1].hw;
    cols.push({ x0, x1, cx: (x0 + x1) / 2 });
  }
  const fps = [];
  for (const col of cols) {
    const side = col.cx > 0 ? 1 : -1;
    const edge = side > 0 ? col.x0 : col.x1;          // boulevard-facing edge (world.js)
    for (let j = 0; j < H_ROADS.length - 1; j++) {
      const z0 = H_ROADS[j] + ROAD_HW, z1 = H_ROADS[j + 1] - ROAD_HW; // row, roads excluded
      for (let z = z0 + 4; z < z1 - 5; z += 16) {       // buildings march in z within the row
        const W = 10, D = 10;
        const bx = side > 0 ? edge + 3 + W / 2 : edge - 3 - W / 2;
        const bz = z + D / 2;
        fps.push({ cx: bx, cz: bz, r: Math.max(W, D) / 2,
          minx: bx - W / 2, maxx: bx + W / 2, minz: bz - D / 2, maxz: bz + D / 2 });
      }
    }
  }
  return fps;
}

const insideAny = (p, fps) => fps.some((f) => p.x > f.minx && p.x < f.maxx && p.z > f.minz && p.z < f.maxz);

test("real-scale navmesh stays connected at production cell/margin", () => {
  const fps = cityFootprints();
  assert.ok(fps.length > 40, `should reconstruct a realistic building count (got ${fps.length})`);

  const navMesh = buildNavMesh(BOUNDS, fps); // production defaults (cell 7, margin 1.5)
  assert.ok(navMesh, "navmesh must build (non-null) from the real city grid");
  assert.ok(navMesh.regions.length > 30, `expected many walkable regions (got ${navMesh.regions?.length})`);

  // The long central boulevard must be one walkable channel end to end.
  const lengthwise = pathPoints(navMesh, 0, 0, 0, 370);
  assert.ok(lengthwise && lengthwise.length >= 2, "boulevard should be traversable end-to-end");

  // Crossing the building line (boulevard → outer sidewalk) must DETOUR through a road gap,
  // never straight through a building. This is the flagship "route around" behavior.
  const detour = pathPoints(navMesh, 5, 100, 55, 100);
  assert.ok(detour && detour.length >= 2, "a route from boulevard to the outer band must exist");
  for (const p of detour) assert.ok(!insideAny(p, fps), `waypoint ${p.x.toFixed(1)},${p.z.toFixed(1)} must avoid buildings`);
});
