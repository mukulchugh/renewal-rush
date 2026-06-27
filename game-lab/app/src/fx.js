// fx.js — Renewal Rush visual layer + game-feel juice (bright, sharp HD tune).
//
// Owns the post-processing stack and all screen/camera "feel". The look is a
// bright, sunny "real world" daylight — NOT dark techno-sci-fi. The de-haze is
// done and stays done: chromatic aberration, film grain, and vignette are OFF
// (they read as fringe/blur and washed everything out). What's left is crisp.
//
//   • DefaultRenderingPipeline — FXAA (the only smoothing we keep) + ACES
//     tone-map + a GENTLE high-threshold bloom that only catches the very
//     brightest neon emissives, so signal-card edges pop without washing out.
//   • SSAO2 — subtle contact shadows for grounding (skipped on WebGL1).
//   • GlowLayer — emissive bloom for indigo neon, with a per-kill / per-pulse
//     additive pulse. Kept conservative: it's GLOBAL (every emissive surface in
//     world/brand/combat feeds it), and the named failure mode in a daylight
//     world is wash-out, so glow biases low and bloomThreshold does the gating.
//   • Camera shake — trauma model, applied screen-space AFTER the controller
//     positions the camera each frame, removed after render so the controller
//     never sees the offset.
//   • Time control — owns state.timeScale (main multiplies dt by it). Two effects
//     share it and COOPERATE via min(scale): a brief HIT-STOP (impact freeze) and a
//     decoupled SLOW-MO (the shootdodge bullet-time, ctx.fx.slowmo). Both count down
//     in REAL time so they always recover even when timeScale ~= 0; slow-mo eases out
//     over a short tail so the world RAMPS back to full speed instead of snapping.
//   • Screen flash — a clean indigo "deploy" flash on kill/pulse (scaled by the
//     real ARR payoff so Full-Stack / Critical / boss saves hit harder), plus a
//     SUBTLE red sting on damage (no full-screen red wash — the HUD edge carries
//     damage feedback).
//   • Impact particle bursts on kills, colored by what you hit (signal kind).
//
// Exposes ctx.fx = { shake, hitStop, slowmo, flash, dispose } (also returned).
//
// NOTE: glow / bloom / SSAO strengths below are conservative picks pending the
// GPU-browser playtest (headless Chrome has no WebGL context). They are flagged
// as PLAYTEST-TUNABLE — easier to push glow up after seeing it than to ship a
// washed-out look.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";

// ── Tunables (PLAYTEST-TUNABLE — see header) ──────────────────────────────────
const GLOW_BASE = 0.8; // baseline GlowLayer intensity (global; keep conservative)
const GLOW_PULSE_MAX = 1.4; // max additive pulse on top of base
const GLOW_DECAY = 2.6; // glow pulse units/sec

// Bloom: high threshold so only the brightest neon emissives bloom (not the
// daylight-lit world); gentle weight so card edges pop without a soup.
const BLOOM_THRESHOLD = 0.9; // only the very brightest pop
const BLOOM_WEIGHT = 0.25; // gentle
const BLOOM_KERNEL = 32; // tight kernel = sharp halo, not a smear
const BLOOM_SCALE = 0.5; // half-res bloom buffer (perf; doesn't blur the scene)

// SSAO: subtle grounding only — must not muddy the bright look.
const SSAO_RADIUS = 0.9;
const SSAO_STRENGTH = 0.5;
const SSAO_SAMPLES = 16;

// Tone-map: bright, punchy, SATURATED — the "Total Overdose" sun-drenched look.
// Saturation comes from ColorCurves (GlobalSaturation up); a touch more exposure +
// contrast makes the daylight vivid, NOT washed. CA / grain / vignette stay OFF.
const TONE_EXPOSURE = 1.06;
const TONE_CONTRAST = 1.2;
const SATURATION = 42; // ColorCurves.globalSaturation (-100..100); + = more vivid

const MAX_SHAKE = 0.45; // world-units lateral offset at trauma=1
const TRAUMA_DECAY = 1.6; // trauma units/sec (1 -> 0 in ~0.6s)
const MIN_TRAUMA = 0.0015;
const SHAKE_F1 = 37.0; // shake noise frequencies (rad/sec)
const SHAKE_F2 = 71.0;

const HITSTOP_SCALE = 0.04; // near-freeze (not 0, so other modules never /0 dt)

const FLASH_DECAY = 9.0; // flash opacity e-fold/sec (~0.2s fade)
const FLASH_Z = 40; // overlay z-index (above canvas, brief over HUD is fine)

// Real ARR (game.js economy) that maps a single catch to "max juice". A Critical
// Full-Stack save (BUCKET_ARR 800 × fullStackMult 2) lands ~here, so great plays
// peak the flash/shake/hit-stop while ordinary single-source catches stay calm.
const DEPLOY_ARR_FULL = 1600;

// Brand palette (CSS for flashes).
const BRAND = {
  indigo: "#6366F1",
  success: "#34D399",
  warning: "#FBBF24",
  risk: "#F87171",
  white: "#FFFFFF",
};

// Particle burst color per enemy kind (0..1 rgb) — colors "what you hit".
const KIND_COLORS = {
  signal: rgb01(0x63, 0x66, 0xf1), // indigo
  churn: rgb01(0xf8, 0x71, 0x71), // risk red
  boss: rgb01(0xfb, 0xbf, 0x24), // amber
  healthy: rgb01(0x34, 0xd3, 0x99), // success green
};

// Reusable local axes (never mutated).
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_FWD = new Vector3(0, 0, 1);

export function createFx(ctx) {
  const { engine, scene, camera, canvas, bus, onFrame, state } = ctx;
  if (state && state.timeScale == null) state.timeScale = 1;

  let disposed = false;

  // ── Post-processing pipeline ───────────────────────────────────────────────
  const pipeline = new DefaultRenderingPipeline("rr-fx", true, scene, [camera]);

  pipeline.fxaaEnabled = true; // clean edges (the only "smoothing" we keep)

  // Gentle, high-threshold bloom: sparkle on the brightest neon highlights only,
  // NOT the wash-out neon soup. This is the knob that makes signal-card emissive
  // edges pop while leaving the daylight world crisp.
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = BLOOM_THRESHOLD;
  pipeline.bloomWeight = BLOOM_WEIGHT;
  pipeline.bloomKernel = BLOOM_KERNEL;
  pipeline.bloomScale = BLOOM_SCALE;

  // De-haze: these stay OFF (they were the "blur"/fringe/techno culprits).
  pipeline.chromaticAberrationEnabled = false;
  pipeline.grainEnabled = false;

  // Tone-mapping for clean color; NO vignette = bright + readable to the edges.
  const ip = pipeline.imageProcessing || null;
  if (ip) {
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = TONE_EXPOSURE;
    ip.contrast = TONE_CONTRAST;
    ip.vignetteEnabled = false; // OFF — damage feedback is HUD-edge + subtle flash

    // Saturation boost — the "vibrant" fix. Push global saturation hard, with the
    // shadows/highlights pulled up a little less so colors stay rich but not neon-clipped.
    try {
      const curves = new ColorCurves();
      curves.globalSaturation = SATURATION;
      curves.highlightsSaturation = SATURATION * 0.55;
      curves.shadowsSaturation = SATURATION * 0.35;
      ip.colorCurves = curves;
      ip.colorCurvesEnabled = true;
    } catch (_) {
      /* never let color grading block the render path */
    }
  }

  // ── SSAO2 (WebGL2 only) ────────────────────────────────────────────────────
  // Full-res ratio (1.0) keeps contact shadows sharp; strength stays subtle so
  // the bright look isn't muddied.
  let ssao = null;
  try {
    if (SSAO2RenderingPipeline.IsSupported) {
      ssao = new SSAO2RenderingPipeline("rr-ssao", scene, 1.0, [camera]);
      ssao.radius = SSAO_RADIUS;
      ssao.totalStrength = SSAO_STRENGTH;
      ssao.samples = SSAO_SAMPLES;
      ssao.expensiveBlur = true;
    }
  } catch {
    ssao = null; // never let AO block the render path
  }

  // ── GlowLayer ──────────────────────────────────────────────────────────────
  const glow = new GlowLayer("rr-glow", scene, { blurKernelSize: 24 });
  glow.intensity = GLOW_BASE;
  let glowPulse = 0;

  // ── Soft round spark texture (shared by all bursts) ────────────────────────
  const sparkTex = makeSparkTexture(scene);
  const activePS = new Set();

  // ── Screen flash overlay (DOM) ─────────────────────────────────────────────
  const flashEl = makeFlashOverlay(canvas);
  let flashAlpha = 0;

  // ── Camera shake state (trauma model) ──────────────────────────────────────
  let trauma = 0;
  let applied = false;
  const offset = new Vector3(0, 0, 0);
  const _right = new Vector3(0, 0, 0);
  const _up = new Vector3(0, 0, 0);
  const _fwd = new Vector3(0, 0, 0);

  // Real (wall-clock) dt — independent of state.timeScale so hit-stop recovers.
  const realDt = () => Math.min(0.1, (engine.getDeltaTime() || 16.7) / 1000);

  // Apply the shake offset. Registered on "start" so it runs as the LAST
  // onBeforeRender observer (after the controller has set camera.position and
  // before the view matrix is baked) — this is what makes the shake render.
  const applyShake = () => {
    if (disposed) return;
    const dt = realDt();
    if (trauma > 0) trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
    applied = false;
    if (trauma <= MIN_TRAUMA) return;

    const amp = trauma * trauma * MAX_SHAKE; // squared falloff feels best
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 0.001;
    const nx = noise(t, 11.3);
    const ny = noise(t, 53.7);
    const nz = noise(t, 91.1);

    camera.getDirectionToRef(LOCAL_RIGHT, _right);
    camera.getDirectionToRef(LOCAL_UP, _up);
    camera.getDirectionToRef(LOCAL_FWD, _fwd);

    offset.set(0, 0, 0);
    offset.addInPlace(_right.scaleInPlace(nx * amp));
    offset.addInPlace(_up.scaleInPlace(ny * amp));
    offset.addInPlace(_fwd.scaleInPlace(nz * amp * 0.35));

    camera.position.addInPlace(offset);
    applied = true;
  };

  // Remove the offset after the frame renders so the controller reads a clean
  // position next frame. onAfterRender is always the final hook of the frame.
  const restoreShake = () => {
    if (!applied) return;
    camera.position.subtractInPlace(offset);
    applied = false;
  };

  let addObs = null;
  const mountShake = () => {
    if (disposed) return;
    if (addObs) scene.onBeforeRenderObservable.remove(addObs);
    addObs = scene.onBeforeRenderObservable.add(applyShake); // appended -> runs last
  };
  mountShake(); // present immediately; re-mounted on "start" to stay last
  const removeObs = scene.onAfterRenderObservable.add(restoreShake);

  // ── Time control: hit-stop + slow-mo (both own state.timeScale; cooperate) ──
  // Effective scale = min of every live effect, so a deep slow-mo and a hit-stop never
  // fight — the smaller wins until it expires, and timeScale is never left stuck. Both
  // burn in REAL wall-clock time so they always recover even at timeScale ~= 0.
  let hitStopLeft = 0;
  let slowmoLeft = 0;
  let slowmoScale = 1;
  const SLOWMO_TAIL = 0.3; // s of ease-out back toward 1 at the end of a slow-mo

  // Current effective slow-mo multiplier, with an eased tail so the world RAMPS back
  // up (the shootdodge landing) instead of snapping. 1 when no slow-mo is live.
  function slowmoNow() {
    if (slowmoLeft <= 0) return 1;
    if (slowmoLeft >= SLOWMO_TAIL) return slowmoScale;
    const k = slowmoLeft / SLOWMO_TAIL; // 1 -> 0 across the tail
    return slowmoScale + (1 - slowmoScale) * (1 - k); // ease toward 1
  }

  // Recompute state.timeScale from whatever effects are live (smaller wins). meta.js
  // (Last Stand) re-caps AFTER fx and only when timeScale > its floor, so a deeper
  // slow-mo here survives the overlap and meta restores its floor once we expire.
  function applyTimeScale() {
    if (!state) return;
    let s = 1;
    if (hitStopLeft > 0) s = Math.min(s, HITSTOP_SCALE);
    const sm = slowmoNow();
    if (sm < 1) s = Math.min(s, sm);
    state.timeScale = s;
  }

  // ── Per-frame simulation (real dt; timeScale-independent) ───────────────────
  onFrame(() => {
    if (disposed) return;
    const dt = realDt();

    // Time-control countdowns (frozen while paused). Real dt → always recover.
    if (!(state && state.paused) && (hitStopLeft > 0 || slowmoLeft > 0)) {
      if (hitStopLeft > 0) hitStopLeft = Math.max(0, hitStopLeft - dt);
      if (slowmoLeft > 0) slowmoLeft = Math.max(0, slowmoLeft - dt);
      applyTimeScale();
    }

    // Glow pulse decay.
    if (glowPulse > 0.001) glowPulse = Math.max(0, glowPulse - GLOW_DECAY * dt);
    glow.intensity = GLOW_BASE + glowPulse;

    // Screen flash fade.
    if (flashAlpha > 0.004) {
      flashAlpha *= Math.exp(-FLASH_DECAY * dt);
      if (flashAlpha < 0.004) flashAlpha = 0;
      if (flashEl) flashEl.style.opacity = String(flashAlpha);
    } else if (flashAlpha !== 0) {
      flashAlpha = 0;
      if (flashEl) flashEl.style.opacity = "0";
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  function shake(amount = 0.3) {
    if (disposed) return;
    trauma = clamp01(trauma + (amount || 0));
  }

  function hitStop(seconds = 0.06) {
    if (disposed || !state) return;
    const s = Math.max(0, seconds || 0);
    if (s <= 0) return;
    hitStopLeft = Math.max(hitStopLeft, s);
    applyTimeScale(); // take effect immediately, not next frame
  }

  // Decoupled slow-mo — the shootdodge bullet-time. `scale` is the world multiplier
  // (~0.2 = deep slow); `realSeconds` counts down in WALL-CLOCK time (look + the dive
  // arc + the fire cadence all run at real rate; only the WORLD sim is slowed). Plays
  // nice with hitStop via min(scale): a hit-stop can still dip deeper for punch, and
  // whichever is deeper wins until it expires. Overlapping calls take the deeper slow
  // and the longer window.
  function slowmo(scale = 0.2, realSeconds = 0.5) {
    if (disposed || !state) return;
    const sc = clamp(scale == null ? 0.2 : scale, 0.02, 1);
    const t = Math.max(0, realSeconds || 0);
    if (t <= 0) return;
    slowmoScale = slowmoLeft > 0 ? Math.min(slowmoScale, sc) : sc;
    slowmoLeft = Math.max(slowmoLeft, t);
    applyTimeScale();
  }

  function flash(color = BRAND.white, peak = 0.5) {
    if (disposed) return;
    const css = toCss(color);
    if (flashEl) {
      flashEl.style.background = css;
      flashAlpha = Math.min(1, Math.max(flashAlpha, peak));
      flashEl.style.opacity = String(flashAlpha);
    } else {
      flashAlpha = Math.min(1, Math.max(flashAlpha, peak));
    }
  }

  function addGlow(amount) {
    glowPulse = Math.min(GLOW_PULSE_MAX, glowPulse + amount);
  }

  // ── Impact particle burst ──────────────────────────────────────────────────
  function burst(position, kind = "signal", scale = 1) {
    if (disposed || !position) return;
    const col = KIND_COLORS[kind] || KIND_COLORS.signal;
    const count = Math.round(34 * scale);

    const ps = new ParticleSystem("rr-burst", Math.ceil(count * 1.6) + 8, scene);
    ps.particleTexture = sparkTex;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD; // additive neon
    ps.emitter = new Vector3(position.x, position.y, position.z); // fixed point, cloned

    ps.color1 = new Color4(col.r, col.g, col.b, 1);
    ps.color2 = new Color4(
      Math.min(1, col.r + 0.4),
      Math.min(1, col.g + 0.4),
      Math.min(1, col.b + 0.4),
      1
    );
    ps.colorDead = new Color4(col.r, col.g, col.b, 0);

    ps.minSize = 0.05 * scale;
    ps.maxSize = 0.18 * scale;
    ps.minLifeTime = 0.15;
    ps.maxLifeTime = 0.45;
    ps.gravity = new Vector3(0, -3.2, 0);
    ps.minEmitPower = 2.5 * scale;
    ps.maxEmitPower = 7 * scale;
    ps.minAngularSpeed = -4;
    ps.maxAngularSpeed = 4;
    ps.updateSpeed = 0.02;

    ps.createSphereEmitter(0.05 * scale, 1); // radial pop in all directions

    // One-shot, self-disposing burst.
    ps.emitRate = count / 0.03;
    ps.targetStopDuration = 0.05;
    ps.disposeOnStop = true;

    activePS.add(ps);
    ps.onDisposeObservable.addOnce(() => activePS.delete(ps));
    ps.start();
  }

  // ── Bus wiring ─────────────────────────────────────────────────────────────
  const offFns = [];
  const on = (name, fn) => {
    const h = (p) => {
      if (disposed) return;
      fn(p || {});
    };
    bus.on(name, h);
    offFns.push(() => bus.off?.(name, h));
  };

  on("start", () => mountShake()); // re-mount so applyShake stays the last hook

  // Kill = an agent deployed onto a signal → a clean INDIGO "deploy" flash.
  // Juice scales with the real ARR payoff (BUCKET_ARR × fullStack × combo ×
  // director) so Full-Stack / Critical / boss saves land hardest. Peaks are kept
  // low so rapid kills don't strobe — flash()'s max() accumulation handles it.
  on("kill", (p) => {
    const kind = p.kind || "signal";
    const boss = kind === "boss";
    const payoff = clamp01((p.arr || 0) / DEPLOY_ARR_FULL); // 0..1

    shake(boss ? 0.55 : 0.18 + payoff * 0.16);
    addGlow(boss ? 0.95 : 0.32 + payoff * 0.5);

    // Indigo deploy flash regardless of what was hit — the screen says "deployed".
    flash(BRAND.indigo, boss ? 0.26 : 0.07 + payoff * 0.15);

    // Particle burst colors WHAT you hit (kind), sized by payoff.
    burst(p.position, kind, boss ? 1.9 : 1 + payoff * 0.6);

    // Hit-stop only on the big, deserving saves (boss or near-max payoff).
    if (boss) hitStop(0.1);
    else if (payoff > 0.66) hitStop(0.06);
  });

  // Pulse = AoE deploy → the signature indigo deploy flash.
  on("pulse", () => {
    shake(0.5);
    addGlow(0.7);
    flash(BRAND.indigo, 0.2);
    hitStop(0.05);
  });

  // Damage = SUBTLE only. No full-screen red wash — the HUD edge carries it.
  on("hurt", (p) => {
    const amt = p.amount != null ? p.amount : 10;
    shake(clamp(0.26 + amt * 0.008, 0.26, 0.5));
    flash(BRAND.risk, 0.08); // barely-there sting
    hitStop(0.04);
  });

  // False positive = deploying onto a healthy account → amber warning sting.
  on("hitHealthy", () => {
    shake(0.26);
    flash(BRAND.warning, 0.1);
  });

  // Escape = a signal reached the gate → amber warning, scaled by severity.
  on("escape", (p) => {
    const sev = p.severity || 1;
    shake(0.2 + sev * 0.05);
    flash(BRAND.warning, 0.14);
  });

  on("win", () => {
    flash(BRAND.success, 0.45);
    addGlow(1.0);
  });

  on("lose", () => {
    flash(BRAND.risk, 0.55);
    shake(0.5);
  });

  // ── Teardown ───────────────────────────────────────────────────────────────
  function dispose() {
    if (disposed) return;
    disposed = true;

    try {
      if (addObs) scene.onBeforeRenderObservable.remove(addObs);
    } catch {}
    addObs = null;
    try {
      scene.onAfterRenderObservable.remove(removeObs);
    } catch {}

    if (applied) {
      try {
        camera.position.subtractInPlace(offset);
      } catch {}
      applied = false;
    }
    hitStopLeft = 0;
    slowmoLeft = 0;
    if (state) state.timeScale = 1;

    offFns.forEach((f) => {
      try {
        f();
      } catch {}
    });

    for (const ps of [...activePS]) {
      try {
        ps.dispose();
      } catch {}
    }
    activePS.clear();

    try {
      ssao && ssao.dispose();
    } catch {}
    try {
      pipeline && pipeline.dispose();
    } catch {}
    try {
      glow && glow.dispose();
    } catch {}
    try {
      sparkTex && sparkTex.dispose();
    } catch {}
    try {
      flashEl && flashEl.remove();
    } catch {}
  }

  const api = { shake, hitStop, slowmo, flash, dispose };
  ctx.fx = api; // collaborators optional-chain ctx.fx
  return api;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Two-octave value-ish noise in [-1, 1]; smooth (no per-frame strobe).
function noise(t, seed) {
  return (
    Math.sin(t * SHAKE_F1 + seed) * 0.6 +
    Math.sin(t * SHAKE_F2 + seed * 1.7) * 0.4
  );
}

function makeSparkTexture(scene) {
  const S = 64;
  const tex = new DynamicTexture("rr-spark", S, scene, false);
  tex.hasAlpha = true;
  const c = tex.getContext();
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  tex.update();
  return tex;
}

function makeFlashOverlay(canvas) {
  if (typeof document === "undefined") return null;
  try {
    let host = (canvas && canvas.parentElement) || document.body;
    const onBody = host === document.body;
    if (!onBody) {
      const pos = getComputedStyle(host).position;
      if (pos === "static") host.style.position = "relative";
    }
    const el = document.createElement("div");
    el.className = "rr-fx-flash";
    el.style.cssText = [
      onBody ? "position:fixed" : "position:absolute",
      "inset:0",
      "pointer-events:none",
      "opacity:0",
      "background:#ffffff",
      "will-change:opacity",
      `z-index:${FLASH_Z}`,
    ].join(";");
    host.appendChild(el);
    return el;
  } catch {
    return null;
  }
}

function toCss(color) {
  if (!color) return "#ffffff";
  if (typeof color === "string") return color;
  if (typeof color === "object" && "r" in color) {
    const r = Math.round((color.r || 0) * 255);
    const g = Math.round((color.g || 0) * 255);
    const b = Math.round((color.b || 0) * 255);
    return `rgb(${r},${g},${b})`;
  }
  return "#ffffff";
}

function rgb01(r, g, b) {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
