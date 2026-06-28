// Self-check for the adaptive-quality controller in fx.js. fx.js embeds the decision rule inside
// the render-loop closure (Babylon deps), so this faithfully RE-implements the same rule and
// asserts its regimes. If you change the rule in fx.js, mirror it here. Run: bun test.
import { test } from "node:test";
import assert from "node:assert";

// Mirror of fx.js constants + decision rule.
const DOWN = 0.82, UP = 0.94, EVAL = 1.5, MAXTIER = 2;
const GPU_DOWN_MS = 10.5, GPU_UP_MS = 7.0;
// fpsAt(tier)->fps, gpuAt(tier)->ms (or -1 to simulate no timer-query extension).
function simulate(fpsAt, gpuAt, ticks = 700, dt = 1 / 60) {
  let tier = 0, hold = 0, ceil = 60, elapsed = 0;
  let lastDownFps = 0, downEval = -1, cpuLatch = false;
  for (let i = 0; i < ticks; i++) {
    const fps = fpsAt(tier), g = gpuAt(tier);
    elapsed += dt;
    const warm = elapsed >= 2.5;
    let wantDown, wantUp;
    if (g > 0) {
      wantDown = warm && g > GPU_DOWN_MS && tier < MAXTIER;
      wantUp = warm && g < GPU_UP_MS && tier > 0;
    } else {
      if (tier === 0 && fps > ceil) ceil = Math.min(250, fps);
      ceil = Math.max(55, ceil);
      if (downEval >= 0) { downEval -= dt; if (downEval < 0 && fps < lastDownFps * 1.04 && tier > 0) { cpuLatch = true; tier -= 1; hold = 0; } }
      if (cpuLatch && fps < lastDownFps * 0.85) cpuLatch = false;
      wantDown = warm && !cpuLatch && downEval < 0 && fps < ceil * DOWN && tier < MAXTIER;
      wantUp = warm && fps > ceil * UP && tier > 0;
    }
    if (wantDown || wantUp) {
      hold += dt;
      if (hold >= EVAL) { tier += wantDown ? 1 : -1; hold = 0; if (wantDown) { lastDownFps = fps; downEval = 2.0; } }
    } else hold = 0;
  }
  return { tier, cpuLatch };
}

test("GPU has headroom → holds full quality (the CPU-bound scene's correct behavior)", () => {
  // Near-idle GPU (4ms) regardless of tier; fps low (CPU-bound). Must NOT downscale.
  const r = simulate(() => 52, () => 4);
  assert.equal(r.tier, 0, "full quality must hold when the GPU isn't the bottleneck");
});

test("GPU genuinely heavy → downscales to relieve it", () => {
  // GPU over budget at every tier → should ratchet down to relieve GPU load.
  const r = simulate(() => 45, (tier) => [16, 13, 8][tier]);
  assert.ok(r.tier >= 1, "must downscale when the GPU is the real bottleneck");
});

test("FALLBACK (no GPU timer), CPU-bound: latch on at full quality", () => {
  let warmed = 0;
  const r = simulate(() => (warmed++ < 200 ? 100 : 75), () => -1);
  assert.equal(r.tier, 0, "fps fallback should restore to tier 0, not ratchet to worst");
  assert.equal(r.cpuLatch, true, "should latch off downscaling once it's seen as useless");
});

test("FALLBACK (no GPU timer), GPU-bound: stays downscaled, no false latch", () => {
  let warmed = 0;
  const r = simulate((tier) => (warmed++ < 200 ? 100 : (tier === 0 ? 70 : 90)), () => -1);
  assert.ok(r.tier >= 1, "should accept the helpful downscale");
  assert.equal(r.cpuLatch, false, "must NOT latch when downscaling genuinely helps");
});
