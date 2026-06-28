// enemyai.js — Yuka autonomous-steering layer for Renewal Rush enemies.
//
// The brain (FSM, perception, weapon, tuning) stays in enemies.js. This module owns the
// EXECUTION layer the user asked Yuka to provide:
//   • navmesh pathfinding (route around building blocks instead of stalling on a wall)
//   • Arrive steering toward a per-agent target point (the FSM still picks the point)
//   • Separation + obstacle avoidance (replaces the hand-rolled O(n²) separation)
//   • FollowPath (active only when a navmesh path is set, e.g. blind ADVANCE)
//
// Deliberately RNG-FREE so it never perturbs enemies.js's fxRng stream (the determinism
// guard). Any randomness (patrol jitter) is the CALLER's job — it passes target points in.
//
// The Yuka Vehicle is the authoritative XZ transform while an agent is ALIVE. enemies.js
// copies vehicle.position → root (XZ only; y/yaw/scale stay owned by the pose code) and
// vehicle.velocity → ent.vx/vz so gait + facing keep working unchanged. On death the agent
// is removed from the manager (remove()) and the existing ragdoll / future Havok body owns
// the transform — the two never run on the same body.

import {
  EntityManager, Vehicle, Vector3 as YVec, GameEntity,
  NavMesh, Polygon, Path,
  ArriveBehavior, SeparationBehavior, FollowPathBehavior, ObstacleAvoidanceBehavior,
} from "yuka";

// ── NavMesh from a walkable grid ────────────────────────────────────────────────
// The city is a fixed road grid with building blocks between roads. We overlay a uniform
// grid and emit one convex quad per WALKABLE cell (a cell not covered by a building
// footprint, inflated by `margin` so agents don't clip corners). Adjacent walkable quads
// share exact edge coordinates → Yuka links them into a navigation graph. Yuka merges
// coplanar quads into larger convex regions internally, so this stays cheap.
//
// Returns a NavMesh, or null if the grid is degenerate (caller then just skips pathfinding
// and agents fall back to direct Arrive — today's behavior).
export function buildNavMesh(bounds, footprints, opts = {}) {
  const cell = opts.cell || 7;
  const margin = opts.margin == null ? 1.5 : opts.margin;
  const minX = bounds.minX, maxX = bounds.maxX, minZ = bounds.minZ, maxZ = bounds.maxZ;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));

  // Snap a grid line to an exact value so shared edges between cells match to the bit.
  const gx = (i) => Math.min(maxX, minX + i * cell);
  const gz = (j) => Math.min(maxZ, minZ + j * cell);

  const blocked = (x0, x1, z0, z1) => {
    for (let k = 0; k < footprints.length; k++) {
      const f = footprints[k];
      const fminx = (f.minx ?? f.x - (f.hw ?? f.r ?? 0)) - margin;
      const fmaxx = (f.maxx ?? f.x + (f.hw ?? f.r ?? 0)) + margin;
      const fminz = (f.minz ?? f.z - (f.hd ?? f.r ?? 0)) - margin;
      const fmaxz = (f.maxz ?? f.z + (f.hd ?? f.r ?? 0)) + margin;
      if (x1 > fminx && x0 < fmaxx && z1 > fminz && z0 < fmaxz) return true;
    }
    return false;
  };

  const polygons = [];
  for (let i = 0; i < nx; i++) {
    const x0 = gx(i), x1 = gx(i + 1);
    if (x1 - x0 < 1e-3) continue;
    for (let j = 0; j < nz; j++) {
      const z0 = gz(j), z1 = gz(j + 1);
      if (z1 - z0 < 1e-3) continue;
      if (blocked(x0, x1, z0, z1)) continue;
      // CCW viewed from +Y (Yuka's expected winding for an upward-facing region).
      const poly = new Polygon().fromContour([
        new YVec(x0, 0, z1),
        new YVec(x1, 0, z1),
        new YVec(x1, 0, z0),
        new YVec(x0, 0, z0),
      ]);
      polygons.push(poly);
    }
  }
  if (polygons.length < 2) return null;
  const navMesh = new NavMesh();
  navMesh.fromPolygons(polygons);
  return navMesh;
}

// Path between two XZ points as [{x,z}, …], or null if no route / no navmesh.
export function pathPoints(navMesh, fromX, fromZ, toX, toZ) {
  if (!navMesh) return null;
  const path = navMesh.findPath(new YVec(fromX, 0, fromZ), new YVec(toX, 0, toZ));
  if (!path || path.length < 2) return null;
  const out = [];
  for (const p of path) out.push({ x: p.x, z: p.z });
  return out;
}

// ── Steering manager ────────────────────────────────────────────────────────────
// One EntityManager for all live agents. Buildings become shared obstacle GameEntities for
// ObstacleAvoidanceBehavior. addAgent() returns a thin handle enemies.js drives each frame.
export function createEnemyAI({ bounds, footprints = [], navOpts } = {}) {
  const manager = new EntityManager();
  const navMesh = buildNavMesh(bounds || { minX: -148, maxX: 148, minZ: -8, maxZ: 382 }, footprints, navOpts);

  // Building obstacles (shared, immutable) for avoidance in the direct-seek case.
  const obstacles = [];
  for (const f of footprints) {
    const o = new GameEntity();
    o.position.set(f.cx ?? f.x ?? 0, 0, f.cz ?? f.z ?? 0);
    o.boundingRadius = (f.r ?? Math.max(f.hw || 0, f.hd || 0)) || 1;
    obstacles.push(o);
  }

  function addAgent(x, z, cfg = {}) {
    const v = new Vehicle();
    v.position.set(x, 0, z);
    v.maxSpeed = cfg.maxSpeed || 5;
    v.maxForce = cfg.maxForce || 18;
    v.updateNeighborhood = true;            // required for SeparationBehavior neighbor lists
    v.neighborhoodRadius = cfg.sepRadius || 2.4;
    v.smoother = null;                       // facing handled by enemies.js; raw velocity is fine

    const arrive = new ArriveBehavior(new YVec(x, 0, z), 3, 0.6);
    const sep = new SeparationBehavior();
    sep.weight = cfg.sepWeight || 1.5;        // keep agents apart WITHOUT cancelling the advance
    const avoid = new ObstacleAvoidanceBehavior(obstacles);
    avoid.weight = cfg.avoidWeight || 0.5;
    const follow = new FollowPathBehavior(new Path(), 1.2);
    follow.active = false;                    // off until a navmesh path is set

    v.steering.add(arrive);
    v.steering.add(sep);
    // ObstacleAvoidance is NOT added by default: each building obstacle's radius is the building
    // half-extent, which blankets the ROADS the agents stand on → constant avoidance = stuck.
    // The navmesh path already routes around buildings. Opt in per-agent via cfg.avoid if needed.
    if (cfg.avoid) v.steering.add(avoid);
    v.steering.add(follow);
    manager.add(v);

    return {
      vehicle: v, arrive, sep, avoid, follow,
      // FSM picks the point; Arrive drives to it (direct, with avoidance). Separation +
      // avoidance stay active either way — only Arrive vs FollowPath are mutually exclusive.
      setTarget(tx, tz) { arrive.target.set(tx, 0, tz); arrive.active = true; follow.active = false; },
      setMaxSpeed(s) { v.maxSpeed = s; },
      // Hand a navmesh path to FollowPath (blind ADVANCE). Pass null to clear.
      setPath(points) {
        if (!points || points.length < 2) { follow.active = false; arrive.active = true; return false; }
        follow.path.clear();
        for (const p of points) follow.path.add(new YVec(p.x, 0, p.z));
        follow.active = true;
        arrive.active = false;
        return true;
      },
      onPath() { return follow.active; },
      teleport(tx, tz) { v.position.set(tx, 0, tz); v.velocity.set(0, 0, 0); },
      remove() { manager.remove(v); },
    };
  }

  return {
    manager,
    navMesh,
    obstacles,
    addAgent,
    update(dt) { manager.update(dt); },
    pathTo(fromX, fromZ, toX, toZ) { return pathPoints(navMesh, fromX, fromZ, toX, toZ); },
  };
}
