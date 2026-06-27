// Headless logic tests for the pure meta loop (no Babylon needed). Run: bun test / node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Game,
  multiplierFor,
  comboMult,
  fullStackMult,
  calcRank,
  nextRankArr,
  mutatorFor,
  mulberry32,
  BUCKET_ARR,
  RENEWAL_MS,
  WIN_HEALTH,
} from "../src/game.js";

test("combo multiplier escalates with combo", () => {
  assert.equal(multiplierFor(0), 1);
  assert.equal(multiplierFor(3), 2);
  assert.equal(multiplierFor(6), 3);
  assert.equal(multiplierFor(10), 5);
  // comboMult is the DESIGN-named alias of the same tiers.
  assert.equal(comboMult(0), 1);
  assert.equal(comboMult(10), 5);
});

test("fullStackMult rewards connecting the stack (1 + 0.5*(n-1))", () => {
  assert.equal(fullStackMult(1), 1.0);
  assert.equal(fullStackMult(2), 1.5);
  assert.equal(fullStackMult(3), 2.0);
  assert.equal(fullStackMult(0), 1.0); // guarded floor
});

test("renewal day: enough health enters overtime, too little loses", () => {
  const win = new Game();
  win.tick(RENEWAL_MS);
  // Surviving renewal day is NOT terminal — status stays running, we bank the win
  // and roll into Act 2 (Overtime). DESIGN §1.
  assert.equal(win.status, "running");
  assert.equal(win.phase, "overtime");
  assert.equal(win.wonRenewal, true);
  assert.equal(win.timeLeft, 0);

  const lose = new Game();
  lose.health = WIN_HEALTH - 1;
  lose.tick(RENEWAL_MS);
  assert.equal(lose.status, "lost");
  assert.equal(lose.wonRenewal, false);
});

test("overtime keeps running until health hits 0, then loses", () => {
  const g = new Game();
  g.tick(RENEWAL_MS); // → overtime, status running
  assert.equal(g.status, "running");
  g.elapsed = 0; // sanity: elapsed is tracked independently of timeLeft
  g.tick(5_000);
  assert.equal(g.elapsed, 5_000);
  assert.equal(g.timeLeft, 0); // pinned at 0 during overtime
  g.takeDamage(1000);
  assert.equal(g.health, 0);
  assert.equal(g.status, "lost");
  assert.equal(g.wonRenewal, true); // the renewal win stays banked
});

test("deploySignal payout = baseArr * fullStackMult(chips) * comboMult(combo)", () => {
  const g = new Game();
  // Back-compat anchor: 200 @ chips 1 @ combo 1 === 200.
  assert.equal(g.deploySignal({ baseArr: 200, chips: 1 }), 200);
  assert.equal(g.combo, 1);
  assert.equal(g.deploys, 1);

  // Climb to combo 3 (×2) with single-source saves.
  g.deploySignal({ baseArr: 200, chips: 1 });
  const third = g.deploySignal({ baseArr: 200, chips: 1 });
  assert.equal(third, 400); // 200 * 1.0 * 2

  // Full Stack (3 sources) at a critical bucket, fresh run, combo 1.
  const fs = new Game();
  const crit = fs.deploySignal({ baseArr: BUCKET_ARR.critical, chips: 3 });
  assert.equal(crit, 1600); // 800 * 2.0 * 1
  assert.equal(fs.fullStackCatches, 1);
});

test("escaped signal breaks combo, drains health, raises threat; champion doubles it", () => {
  const g = new Game();
  g.deploySignal({ baseArr: 200, chips: 1 });
  const h0 = g.health, t0 = g.threat;
  g.signalEscaped(1);
  assert.equal(g.combo, 0);
  assert.ok(g.health < h0);
  assert.ok(g.threat > t0);

  // champion_departure escape costs 2× the health hit of the same severity.
  const a = new Game();
  a.signalEscaped(3);
  const normalDrop = 100 - a.health;
  const b = new Game();
  b.signalEscaped(3, { champion: true });
  const championDrop = 100 - b.health;
  assert.equal(championDrop, normalDrop * 2);
});

test("takeDamage to zero ends the run as lost", () => {
  const g = new Game();
  g.takeDamage(1000);
  assert.equal(g.health, 0);
  assert.equal(g.status, "lost");
});

test("hitHealthy penalizes 8 and resets combo", () => {
  const g = new Game();
  g.deploySignal({ baseArr: 200, chips: 1 }); // heals a touch (capped at 100)
  g.hitHealthy();
  assert.equal(g.combo, 0);
  assert.equal(g.health, 92); // 100 - 8
});

test("health caps at 100 and never exceeds it", () => {
  const g = new Game();
  for (let i = 0; i < 10; i++) g.deploySignal({ baseArr: 100, chips: 3 });
  assert.ok(g.health <= 100);
  assert.equal(g.health, 100);
});

test("calcRank maps ARR to named tiers at exact boundaries", () => {
  assert.equal(calcRank(0), "Renewal Rookie");
  assert.equal(calcRank(4999), "Renewal Rookie");
  assert.equal(calcRank(5000), "Account Defender");
  assert.equal(calcRank(14999), "Account Defender");
  assert.equal(calcRank(15000), "CSM Speedrunner");
  assert.equal(calcRank(39999), "CSM Speedrunner");
  assert.equal(calcRank(40000), "VP Retention");
  assert.equal(calcRank(79999), "VP Retention");
  assert.equal(calcRank(80000), "Chief Renewal Officer");
  assert.equal(calcRank(250000), "Chief Renewal Officer");
});

test("nextRankArr reports remaining $ to the next tier (0 at the top)", () => {
  assert.equal(nextRankArr(0), 5000);
  assert.equal(nextRankArr(5000), 10000);
  assert.equal(nextRankArr(39999), 1);
  assert.equal(nextRankArr(80000), 0);
  assert.equal(nextRankArr(123456), 0);
});

test("snapshot exposes phase, wonRenewal, rank, nextRankArr, mutator", () => {
  const g = new Game();
  const s = g.snapshot();
  assert.equal(s.phase, "renewal");
  assert.equal(s.wonRenewal, false);
  assert.equal(s.rank, "Renewal Rookie");
  assert.equal(s.nextRankArr, 5000);
  assert.equal(typeof s.mutator, "string");
  assert.equal(typeof s.mutatorId, "string");
});

test("seed-friendly: same seed → same mutator + identical RNG stream", () => {
  const a = new Game(1234);
  const b = new Game(1234);
  assert.equal(a.mutator.id, b.mutator.id);
  // RNG streams reproduce exactly.
  const sa = [a.rng(), a.rng(), a.rng()];
  const sb = [b.rng(), b.rng(), b.rng()];
  assert.deepEqual(sa, sb);

  // No-seed run is the neutral, approachable "standard" mutator and is deterministic.
  assert.equal(new Game().mutator.id, "standard");
  assert.equal(new Game().mutator.id, new Game().mutator.id);

  // mutatorFor is pure + deterministic for a given seed.
  assert.equal(mutatorFor(42).id, mutatorFor(42).id);
});

test("reset() with no arg reuses the stored seed (restart determinism)", () => {
  const g = new Game(777);
  const firstMutator = g.mutator.id;
  const firstDraw = g.rng();
  g.deploySignal({ baseArr: 800, chips: 2 });
  g.reset(); // bare reset — must keep seed 777
  assert.equal(g.seed, 777);
  assert.equal(g.mutator.id, firstMutator);
  assert.equal(g.rng(), firstDraw); // fresh stream from the same seed
  assert.equal(g.arr, 0);
  assert.equal(g.combo, 0);
});

test("mulberry32 is a deterministic [0,1) generator", () => {
  const r = mulberry32(99);
  const v = r();
  assert.ok(v >= 0 && v < 1);
  assert.equal(mulberry32(99)(), v);
});

test("no scoring after the run ends (health 0 → lost)", () => {
  const g = new Game();
  g.takeDamage(1000); // → lost
  const arr = g.arr;
  assert.equal(g.deploySignal({ baseArr: 999 }), 0);
  assert.equal(g.arr, arr);
});
