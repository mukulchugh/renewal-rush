// controller.js — advanced, weighty free-movement FPS controller for Renewal Rush.
// Replaces the old 3-lane rail + look-clamp with a full 6-DOF first-person feel:
// WASD relative to camera yaw, unclamped 360 mouse-look (pitch clamped ~±85°),
// momentum + air control, sprint, crouch, a sprint→crouch SLIDE that glides on
// low friction, gravity jump (coyote + buffer), dash (cooldown + i-frames),
// a brief KNOCKBACK + view-kick when the player is hit, head-bob, landing dip,
// strafe lean, and a forward "rush" that pulls momentum and widens FOV at speed.
//
// Contract: exports one factory createController(ctx); registers per-frame work
// via ctx.onFrame INSIDE the factory; owns the camera transform each frame so
// fx.shake (applied after, per ARCHITECTURE init order, via onBeforeRender) layers
// on top of camera.position cleanly and never fights our writes.
//
// SHOOTDODGE DIVE (the Total-Overdose signature move): a committed ballistic LEAP
// (Shift-while-strafing or double-tap A/D) that spends FOCUS, makes you invulnerable,
// and drops the WORLD into slow-mo (fx.slowmo) while your look + the arc + your fire
// run at REAL wall-clock rate. Land into a brief, vulnerable, can't-re-dive recovery.
//
// State extensions written for collaborators (combat/enemies/fx/hud read these):
//   state.invuln   -> true during a dash's i-frames AND the airborne part of a dive
//   state.dashing  -> true while the dash burst is active
//   state.diving   -> true while a shootdodge is airborne (combat = "AIR KILL" bonus)
//   state.focus    -> 0..1 dive fuel; fills from kills, spent on a dive (HUD meter)
//   state.sliding  -> true while a slide is gliding
//   state.crouching-> true while crouch-walking (not sliding)
//   state.locked   -> mirrored from pointer-lock state
// Bus emits (optional hooks for fx/audio/hud):
//   "dash"{x,z} · "slide"{x,z} · "jump" · "land"{impact}
//   "dive"{x,z}                    -> on shootdodge launch
//   "announce"{text,tone}          -> {text:"SHOOTDODGE", tone:"focus"} on launch
// Bus listens: "hurt"{amount[,dir{x,z}][,from{x,z}]} -> applies a capped knockback
//   impulse (skipped during i-frames, matching main.js's damage gate).
//   "kill" -> +focus (the dive fuel fills from neutralizes).
//
// No new Babylon imports: every mechanic here is scalar math on the existing
// velocity / position / camera that main.js already created.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export function createController(ctx) {
  const { engine, scene, camera, canvas, bus, state, onFrame } = ctx;

  // This module OWNS the camera transform. Strip any built-in FreeCamera input
  // (mouse/keyboard) main.js may have attached, so it can't double-rotate and
  // fight our direct yaw/pitch writes. No-op if nothing was attached.
  try {
    camera.inputs && camera.inputs.clear && camera.inputs.clear();
    camera.detachControl && camera.detachControl();
  } catch (_) {}

  // ---- tuning (override via ctx.tuning?.controller) ---------------------------
  const CFG = Object.assign(
    {
      // look
      sensitivity: 0.0022, // rad per pixel of mouse movement
      pitchLimit: 85 * DEG, // hard clamp, never lock straight up/down
      // ground movement
      walkSpeed: 7.5,
      sprintSpeed: 12.5,
      accel: 14, // exponential approach rate toward target velocity
      friction: 11, // ground stopping rate when no input
      // air movement (keep momentum, limited steering)
      airAccel: 3.5,
      airFriction: 0.4,
      // vertical
      gravity: 22,
      jumpSpeed: 7.0, // ~1.1 units of apex
      coyote: 0.1, // grace window to still jump just after leaving ground
      jumpBuffer: 0.12, // grace window to queue a jump just before landing
      // dash
      dashSpeed: 26,
      dashDuration: 0.16,
      dashCooldown: 1.1,
      dashIFrames: 0.22, // invulnerability slightly outlives the burst
      doubleTapMs: 260, // double-tap a movement key to dash that way
      // crouch
      crouchHeight: 0.7, // eye drops this far when crouched / sliding
      crouchSpeedMult: 0.45, // crouch-walk is slow + deliberate
      heightRate: 13, // how fast the eye height eases up/down
      // slide (crouch while carrying speed → low-friction glide)
      slideSpeedCap: 17.5, // top slide speed (faster than sprint — the reward)
      slideBoost: 1.32, // launch multiplier over entry speed
      slideMinSpeed: 4.5, // below this a slide can't start / ends
      slideFriction: 2.3, // MUCH lower than walk friction → you glide
      slideDuration: 0.85, // max slide length before you stand
      slideCooldown: 0.45, // brief gate so it can't be spammed
      slideSteerAccel: 16, // limited mid-slide steering
      slideJumpKeep: 1.08, // slide-jump preserves (slightly boosts) momentum
      slideFovKick: 0.09, // punchy widen on slide entry
      // shootdodge dive (the signature Total-Overdose leap) — see DESIGN §0b
      diveCost: 0.5, // FOCUS spent per dive (state.focus 0..1)
      diveLaunchSpeed: 15, // horizontal launch (u/s) along aim/strafe dir
      diveLaunchUp: 5.5, // vertical launch (u/s)
      diveGravity: 14, // LOWER than walk gravity → ~0.79s hang (spec wants 0.7-1.0s)
      diveSlowScale: 0.2, // world timeScale during the dive (via fx.slowmo)
      diveSlowExtra: 0.35, // slow-mo seconds past airtime (covers the landing recovery)
      diveMaxTime: 1.2, // safety cap on airborne time (s) if ground-contact never fires
      diveRoll: 10 * Math.PI / 180, // camera roll toward the dive direction (radians)
      diveLeanRate: 9, // how fast the dive-lean eases in (air) / out (land)
      diveFovKick: 0.18, // FOV widen on launch (eased back by fovRecover/fovRate)
      diveLandSkid: 0.28, // fraction of dive speed carried into the landing slide
      landRecovery: 0.35, // s of slowed, vulnerable, can't-re-dive get-up
      landRecoverMove: 0.45, // movement speed mult during landing recovery
      landThud: 0.28, // fx.shake amount on dive touchdown
      focusStart: 0.6, // FOCUS at run start (enough for one dive to learn the move)
      focusPerKill: 0.18, // FOCUS gained per "kill"
      // knockback (incoming "hurt" → brief stagger, NOT a launch)
      hurtImpulsePerDmg: 0.5, // amount 12 → 6 u/s, amount 24 → 12 u/s (then clamped)
      hurtImpulseMin: 4,
      hurtImpulseMax: 13, // hard cap on the per-frame shove (swarm-safe)
      hurtLift: 1.6, // tiny vertical pop so a hit reads as weight, not a slap
      hurtPitchKick: 0.06, // view jolts up (radians)
      hurtRollKick: 0.05, // view jitters sideways (radians)
      hurtFovKick: 0.06, // brief FOV pinch on impact
      hurtKickRecover: 6.5, // view-kick e-fold/sec back to neutral
      // camera feel
      bobPerUnit: 1.1, // head-bob phase advance per world-unit travelled
      bobAmpY: 0.06,
      bobAmpX: 0.035,
      rollMax: 0.028, // strafe lean (radians)
      rollRate: 9,
      dipScale: 0.012, // landing dip per unit of impact speed
      dipMax: 0.12,
      dipRecover: 9,
      landPitch: 0.004, // landing pitch nudge per unit of impact speed
      landPitchMax: 0.05,
      landRecover: 10,
      // rush (sprint-forward escalation)
      rushRamp: 1.6, // seconds of sustained sprint-forward to fully charge
      rushBonus: 3.0, // extra top speed at full charge
      rushPull: 4.0, // forward momentum nudge at full charge
      // fov
      fovBoost: 0.16, // added at full rush
      fovSpeed: 0.05, // added proportional to current speed
      fovDash: 0.1, // punchy kick on dash
      fovRecover: 6, // dash-kick decay
      fovRate: 7, // how fast fov chases its target
      // stability
      maxDt: 0.05, // clamp dt so tab-refocus can't fling the player
    },
    (ctx.tuning && ctx.tuning.controller) || {}
  );

  const KEYS = Object.assign(
    {
      forward: ["KeyW", "ArrowUp"],
      back: ["KeyS", "ArrowDown"],
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD", "ArrowRight"],
      jump: ["Space"],
      sprint: ["ShiftLeft", "ShiftRight"],
      dash: ["KeyQ"], // tap to dash (also double-tap a move key). NOT Ctrl: Ctrl+W
      crouch: ["KeyC"], // hold to crouch; press while fast to slide. NOT Ctrl: Ctrl+W
    }, //                  closes the embedding tab (browsers ignore preventDefault).
    (ctx.tuning && ctx.tuning.keys) || {}
  );

  const HANDLED = new Set();
  for (const list of Object.values(KEYS)) for (const c of list) HANDLED.add(c);

  const DIR = {
    forward: { name: "forward", ix: 0, iz: 1 },
    back: { name: "back", ix: 0, iz: -1 },
    left: { name: "left", ix: -1, iz: 0 },
    right: { name: "right", ix: 1, iz: 0 },
  };

  // ---- authoritative state (we never read it back off the camera) ------------
  const baseFov = camera.fov || 0.8;
  const spawnPos = camera.position.clone();
  const spawnYaw = camera.rotation ? camera.rotation.y : 0;
  let baseY = camera.position.y; // resting eye height = "the floor" for jumps

  // FOCUS meter (dive fuel) lives on shared state so HUD/combat can read it.
  if (state && state.focus == null) state.focus = CFG.focusStart;
  if (state) state.diving = false;

  const _pos = camera.position.clone(); // base eye position (no bob/dip/shake)
  const vel = new Vector3(0, 0, 0); // x,z horizontal · y vertical

  let yaw = spawnYaw;
  let pitch = camera.rotation ? camera.rotation.x : 0;
  let roll = 0;

  let bobPhase = 0;
  let dip = 0;
  let landKick = 0;
  let rush = 0;
  let fovKick = 0;
  let _speed = 0;

  let dashTimer = 0;
  let dashCd = 0;
  let iframeTimer = 0;
  let coyote = 0;
  let jumpBuffer = 0;

  // crouch / slide
  let sliding = false;
  let crouchActive = false; // crouch-walking (held, not sliding)
  let slideTimer = 0;
  let slideCd = 0;
  let wasCrouch = false; // edge-detect crouch press for slide trigger
  let heightOffset = 0; // smoothed eye-drop (<=0) for crouch/slide

  // shootdodge dive
  let diving = false;
  let diveTime = 0; // airborne elapsed (real time)
  let recover = 0; // landing-recovery timer (slowed + vulnerable + can't re-dive)
  let diveLean = 0; // eased camera roll during a dive
  let diveLeanTarget = 0;
  const diveVel = new Vector3(0, 0, 0); // the dive owns its own ballistic velocity
  let diveQueued = null; // { ix, iz } strafe dir queued by input, consumed in step()

  // knockback (incoming hits)
  const hurtQueue = []; // discrete impulses pushed by bus "hurt", drained per frame
  let hurtPitch = 0; // recovering view-kick (up)
  let hurtRoll = 0; // recovering view-kick (sideways)

  // input edges / buffers
  const pressed = new Set();
  const lastTap = { forward: 0, back: 0, left: 0, right: 0 };
  let dashQueued = null; // "auto" | { ix, iz } | null
  const look = { dx: 0, dy: 0 };

  let disposed = false;

  const down = (list) => {
    for (let i = 0; i < list.length; i++) if (pressed.has(list[i])) return true;
    return false;
  };
  const dirOf = (code) => {
    if (KEYS.forward.includes(code)) return DIR.forward;
    if (KEYS.back.includes(code)) return DIR.back;
    if (KEYS.left.includes(code)) return DIR.left;
    if (KEYS.right.includes(code)) return DIR.right;
    return null;
  };

  // ---- input listeners -------------------------------------------------------
  const now = () =>
    (typeof performance !== "undefined" ? performance.now() : Date.now());

  function onKeyDown(e) {
    if (!state || !state.running) return; // don't hijack keys outside the game
    if (!HANDLED.has(e.code)) return;
    e.preventDefault();
    if (pressed.has(e.code)) return; // ignore OS auto-repeat
    pressed.add(e.code);

    if (KEYS.jump.includes(e.code)) jumpBuffer = CFG.jumpBuffer;
    if (KEYS.dash.includes(e.code)) dashQueued = "auto";

    // Shift (the sprint key) PRESSED while already holding a strafe → SHOOTDODGE that
    // way. Plain forward / idle Shift is untouched — it just starts a hold-sprint.
    if (KEYS.sprint.includes(e.code)) {
      const sx = (down(KEYS.right) ? 1 : 0) - (down(KEYS.left) ? 1 : 0);
      if (sx !== 0) diveQueued = { ix: sx, iz: 0 };
    }

    const d = dirOf(e.code);
    if (d) {
      const t = now();
      if (t - lastTap[d.name] < CFG.doubleTapMs) {
        // double-tap a STRAFE (A/D) = shootdodge dive; forward/back = the existing dash
        if (d === DIR.left || d === DIR.right) diveQueued = { ix: d.ix, iz: 0 };
        else dashQueued = { ix: d.ix, iz: d.iz };
      }
      lastTap[d.name] = t;
    }
  }

  function onKeyUp(e) {
    if (!pressed.has(e.code)) return;
    pressed.delete(e.code);
    if (HANDLED.has(e.code)) e.preventDefault();
  }

  function onMouseMove(e) {
    if (!state || !state.locked) return;
    look.dx += e.movementX || 0;
    look.dy += e.movementY || 0;
  }

  function onCanvasDown() {
    // Pointer lock attaches on the first click (user gesture).
    if (document.pointerLockElement !== canvas) {
      const p = canvas.requestPointerLock && canvas.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (state) state.locked = locked;
    if (!locked) {
      pressed.clear(); // never strand a held key when control is released
      look.dx = look.dy = 0;
      dashQueued = null; // drop buffered actions so they can't fire on re-lock
      diveQueued = null;
      jumpBuffer = 0;
      wasCrouch = false;
    }
  }

  function onBlur() {
    pressed.clear();
    look.dx = look.dy = 0;
    wasCrouch = false;
  }

  // Incoming damage → queue a knockback impulse (drained + capped in step()).
  // We push regardless of i-frames; step() makes the final call so a dash that
  // starts the same frame still grants immunity, matching main.js's damage gate.
  function onHurt(p) {
    if (disposed) return;
    if (!state || !state.running || state.paused) return;
    hurtQueue.push({
      amount: (p && p.amount) || 0,
      dir: p && p.dir,
      from: p && p.from,
    });
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("pointerdown", onCanvasDown);

  // ---- per-frame step --------------------------------------------------------
  function step(dt) {
    if (disposed) return;
    dt = Math.min(Math.max(dt || 0, 0), CFG.maxDt);

    // REAL wall-clock dt. The dive arc + its camera + the landing recovery run at full
    // speed even while the WORLD is in slow-mo (state.timeScale). dt above is already
    // scaled by main; rdt is not — same decoupling principle as the raw-delta mouse-look.
    const rdt = Math.min(
      CFG.maxDt,
      ((engine && engine.getDeltaTime && engine.getDeltaTime()) || 16.7) / 1000
    );

    const active =
      !!(state && state.running) && !(state && state.paused) && !!(state && state.locked);
    if (!active) {
      look.dx = look.dy = 0; // drop buffered look so resume doesn't snap
      hurtQueue.length = 0; // and don't bank impulses while not in control
      return;
    }

    // ---- LOOK ----
    yaw += look.dx * CFG.sensitivity;
    pitch += look.dy * CFG.sensitivity; // mouse-down (+) => look down (non-inverted)
    look.dx = look.dy = 0;
    if (yaw > Math.PI) yaw -= TAU;
    else if (yaw < -Math.PI) yaw += TAU;
    if (pitch > CFG.pitchLimit) pitch = CFG.pitchLimit;
    else if (pitch < -CFG.pitchLimit) pitch = -CFG.pitchLimit;

    // horizontal basis from yaw (Babylon left-handed: fwd=(sin,0,cos), right=(cos,0,-sin))
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const fX = sy, fZ = cy;
    const rX = cy, rZ = -sy;

    // ---- INPUT ----
    const ix = (down(KEYS.right) ? 1 : 0) - (down(KEYS.left) ? 1 : 0);
    const iz = (down(KEYS.forward) ? 1 : 0) - (down(KEYS.back) ? 1 : 0);
    const sprint = down(KEYS.sprint);
    const crouchHeld = down(KEYS.crouch);

    let dx = fX * iz + rX * ix;
    let dz = fZ * iz + rZ * ix;
    const dlen = Math.hypot(dx, dz);
    const hasInput = dlen > 1e-4;
    if (hasInput) {
      dx /= dlen;
      dz /= dlen;
    }

    const grounded = _pos.y <= baseY + 1e-3 && vel.y <= 1e-3;

    // landing-recovery timer burns in REAL time (it spans the slow-mo tail)
    if (recover > 0) recover = Math.max(0, recover - rdt);

    // ---- SHOOTDODGE DIVE trigger ----
    // Double-tap A/D or Shift-while-strafing. Needs FOCUS, must be grounded, not already
    // diving, not in landing recovery, not mid-dash. Short on FOCUS → fall back to a dash
    // so the input is never wasted (and sprint-strafing stays usable).
    if (diveQueued) {
      if (
        !diving && recover <= 0 && grounded && dashTimer <= 0 &&
        state && (state.focus || 0) >= CFG.diveCost
      ) {
        launchDive(diveQueued, fX, fZ, rX, rZ);
      } else if (!diving && !dashQueued) {
        dashQueued = { ix: diveQueued.ix, iz: diveQueued.iz };
      }
      diveQueued = null;
    }

    // ---- KNOCKBACK (discrete hurt impulses; drained + capped this frame) ----
    if (hurtQueue.length) {
      // i-frames (dash) phase us through the hit entirely — same gate as damage.
      if (!(state && state.invuln) && dashTimer <= 0) {
        let kx = 0, kz = 0, lift = 0, any = false;
        for (let i = 0; i < hurtQueue.length; i++) {
          const h = hurtQueue[i];
          any = true;
          let ux, uz;
          if (h.from) {
            ux = _pos.x - h.from.x; // shoved away from the attacker if given
            uz = _pos.z - h.from.z;
          } else if (h.dir) {
            ux = h.dir.x || 0;
            uz = h.dir.z || 0;
          } else {
            ux = -fX; // default: shoved back off your aim (reads as "took a hit")
            uz = -fZ;
          }
          let ul = Math.hypot(ux, uz);
          if (ul < 1e-4) { ux = -fX; uz = -fZ; ul = 1; }
          const imp = clamp(
            (h.amount || 0) * CFG.hurtImpulsePerDmg,
            CFG.hurtImpulseMin,
            CFG.hurtImpulseMax
          );
          kx += (ux / ul) * imp;
          kz += (uz / ul) * imp;
          lift = Math.max(lift, CFG.hurtLift); // never stack the vertical pop
        }
        // cap the TOTAL horizontal shove so a multi-seeker frame can't fling you
        const kl = Math.hypot(kx, kz);
        if (kl > CFG.hurtImpulseMax) {
          const s = CFG.hurtImpulseMax / kl;
          kx *= s;
          kz *= s;
        }
        vel.x += kx;
        vel.z += kz;
        if (grounded && lift > 0) vel.y = Math.max(vel.y, lift);
        if (any) {
          hurtPitch -= CFG.hurtPitchKick; // jolt the view up
          hurtRoll += (Math.random() < 0.5 ? -1 : 1) * CFG.hurtRollKick;
          fovKick = Math.max(fovKick, CFG.hurtFovKick);
          if (sliding) endSlide(); // a hit staggers you out of a slide
        }
      }
      hurtQueue.length = 0;
    }

    // ---- DASH trigger ----
    dashCd = Math.max(0, dashCd - dt);
    if (dashQueued && dashCd <= 0 && dashTimer <= 0 && !diving) {
      let ddx, ddz;
      if (dashQueued === "auto") {
        if (hasInput) {
          ddx = dx;
          ddz = dz;
        } else {
          ddx = fX;
          ddz = fZ;
        }
      } else {
        let qx = fX * dashQueued.iz + rX * dashQueued.ix;
        let qz = fZ * dashQueued.iz + rZ * dashQueued.ix;
        const ql = Math.hypot(qx, qz) || 1;
        ddx = qx / ql;
        ddz = qz / ql;
      }
      if (sliding) endSlide(); // dash cancels a slide cleanly
      vel.x = ddx * CFG.dashSpeed;
      vel.z = ddz * CFG.dashSpeed;
      vel.y = 0;
      dashTimer = CFG.dashDuration;
      iframeTimer = CFG.dashIFrames;
      dashCd = CFG.dashCooldown;
      fovKick = CFG.fovDash;
      if (state) {
        state.dashing = true;
        state.invuln = true;
      }
      bus && bus.emit && bus.emit("dash", { x: ddx, z: ddz });
    }
    dashQueued = null;

    const dashing = dashTimer > 0;

    // ---- MOVEMENT integrate ----
    if (diving) {
      // committed ballistic ARC. Integrate with REAL dt so the leap plays at full speed
      // while the world crawls. No ground steering — the leap is committed (DESIGN §0b).
      diveTime += rdt;
      diveVel.y -= CFG.diveGravity * rdt;
      _pos.x += diveVel.x * rdt;
      _pos.y += diveVel.y * rdt;
      _pos.z += diveVel.z * rdt;
      // end on the descent back to ground (or the safety cap)
      if ((_pos.y <= baseY && diveVel.y <= 0) || diveTime >= CFG.diveMaxTime) {
        _pos.y = baseY;
        endDive();
      }
    } else if (dashing) {
      // clean horizontal blink: constant velocity, no gravity, frozen height
      dashTimer -= dt;
      _pos.x += vel.x * dt;
      _pos.z += vel.z * dt;
    } else {
      const hspeed = Math.hypot(vel.x, vel.z);

      // ---- SLIDE state machine (ground only) ----
      // Start: tap crouch while carrying speed (or sprint-moving). Glide on low
      // friction, lowered profile, limited steering — the advanced traversal tool.
      if (
        crouchHeld && !wasCrouch && grounded && !sliding && slideCd <= 0 &&
        ((sprint && hasInput) || hspeed >= CFG.slideMinSpeed)
      ) {
        let lx = vel.x, lz = vel.z;
        const ll = Math.hypot(lx, lz);
        if (ll < 1e-3) { lx = fX; lz = fZ; } // standing-start slide goes where you aim
        else { lx /= ll; lz /= ll; }
        const launch = Math.min(
          Math.max(hspeed, CFG.sprintSpeed) * CFG.slideBoost,
          CFG.slideSpeedCap
        );
        vel.x = lx * launch;
        vel.z = lz * launch;
        sliding = true;
        slideTimer = CFG.slideDuration;
        fovKick = Math.max(fovKick, CFG.slideFovKick);
        if (state) state.sliding = true;
        bus && bus.emit && bus.emit("slide", { x: lx, z: lz });
      }

      // End: crouch released, left the ground, timed out, or bled below min speed.
      if (sliding) {
        slideTimer -= dt;
        if (
          !crouchHeld || !grounded || slideTimer <= 0 ||
          Math.hypot(vel.x, vel.z) < CFG.slideMinSpeed
        ) {
          endSlide();
        }
      }

      crouchActive = grounded && crouchHeld && !sliding;
      if (state) state.crouching = crouchActive;

      // rush charges only during free sprint-forward (never while slide/crouch)
      const rushing = sprint && iz > 0 && grounded && !sliding && !crouchActive;
      rush += (rushing ? dt : -dt) / CFG.rushRamp;
      if (rush > 1) rush = 1;
      else if (rush < 0) rush = 0;

      if (sliding) {
        // gliding: low friction bleed + limited steering, capped at slide speed
        const t = 1 - Math.exp(-CFG.slideFriction * dt);
        vel.x += -vel.x * t;
        vel.z += -vel.z * t;
        if (hasInput) {
          vel.x += dx * CFG.slideSteerAccel * dt;
          vel.z += dz * CFG.slideSteerAccel * dt;
          const s = Math.hypot(vel.x, vel.z);
          if (s > CFG.slideSpeedCap) {
            const k = CFG.slideSpeedCap / s;
            vel.x *= k;
            vel.z *= k;
          }
        }
      } else {
        // landing recovery slows you (and you can't re-dive) — the dive's risk/cost
        const recMult = recover > 0 ? CFG.landRecoverMove : 1;
        const targetSpeed = (crouchActive
          ? CFG.walkSpeed * CFG.crouchSpeedMult
          : (sprint ? CFG.sprintSpeed : CFG.walkSpeed) + rush * CFG.rushBonus) * recMult;
        const desVx = dx * targetSpeed;
        const desVz = dz * targetSpeed;

        const accel = grounded ? CFG.accel : CFG.airAccel;
        const friction = grounded ? CFG.friction : CFG.airFriction;

        if (hasInput) {
          const t = 1 - Math.exp(-accel * dt);
          vel.x += (desVx - vel.x) * t;
          vel.z += (desVz - vel.z) * t;
          // forward "rush pull": nudge momentum along aim as charge builds
          if (!crouchActive) {
            vel.x += fX * rush * CFG.rushPull * dt;
            vel.z += fZ * rush * CFG.rushPull * dt;
          }
        } else {
          const t = 1 - Math.exp(-friction * dt);
          vel.x += -vel.x * t;
          vel.z += -vel.z * t;
        }
      }

      // jump with coyote-time + input buffering; a slide-jump preserves momentum
      coyote = grounded ? CFG.coyote : Math.max(0, coyote - dt);
      jumpBuffer = Math.max(0, jumpBuffer - dt);
      if (jumpBuffer > 0 && coyote > 0) {
        vel.y = CFG.jumpSpeed;
        if (sliding) {
          // hop out of the slide carrying (slightly boosted) horizontal speed
          const s = Math.hypot(vel.x, vel.z);
          if (s > 1e-3) {
            const keep = Math.min(s * CFG.slideJumpKeep, CFG.slideSpeedCap) / s;
            vel.x *= keep;
            vel.z *= keep;
          }
          endSlide();
        }
        jumpBuffer = 0;
        coyote = 0;
        bus && bus.emit && bus.emit("jump");
      }

      // gravity + integrate
      vel.y -= CFG.gravity * dt;
      _pos.x += vel.x * dt;
      _pos.y += vel.y * dt;
      _pos.z += vel.z * dt;

      // ground collision
      if (_pos.y <= baseY) {
        const impact = -vel.y; // >0 when falling onto the floor
        _pos.y = baseY;
        vel.y = 0;
        if (impact > 0.5) {
          dip = Math.min(impact * CFG.dipScale, CFG.dipMax);
          landKick = Math.min(impact * CFG.landPitch, CFG.landPitchMax);
          bus && bus.emit && bus.emit("land", { impact });
        }
      }
    }

    // expire i-frames / dash flag
    if (iframeTimer > 0) {
      iframeTimer -= dt;
      if (iframeTimer <= 0 && state) state.invuln = false;
    }
    if (!dashing && state && state.dashing) state.dashing = false;

    // ---- camera feel ----
    _speed = Math.hypot(vel.x, vel.z);
    const speedFactor = Math.min(_speed / CFG.sprintSpeed, 1);
    const groundedNow = _pos.y <= baseY + 1e-3;

    let bobY = 0;
    let bobX = 0;
    if (groundedNow && !dashing && !sliding) {
      bobPhase += _speed * dt * CFG.bobPerUnit;
      bobY = Math.sin(bobPhase * 2) * CFG.bobAmpY * speedFactor; // double-bounce per stride
      bobX = Math.cos(bobPhase) * CFG.bobAmpX * speedFactor;
    } else {
      bobPhase += dt * 2; // keep phase rolling so it settles smoothly on land
    }

    dip += -dip * (1 - Math.exp(-CFG.dipRecover * dt));
    landKick += -landKick * (1 - Math.exp(-CFG.landRecover * dt));

    // crouch/slide lower the eye; dash stands you up. Eased so it never snaps.
    const targetHeight = !dashing && (sliding || crouchActive) ? -CFG.crouchHeight : 0;
    heightOffset += (targetHeight - heightOffset) * (1 - Math.exp(-CFG.heightRate * dt));

    // strafe lean, plus a touch extra into a slide for cornering bite
    const rollTarget = -ix * CFG.rollMax * speedFactor * (sliding ? 1.5 : 1);
    roll += (rollTarget - roll) * (1 - Math.exp(-CFG.rollRate * dt));

    // dive lean — camera rolls toward the dive direction; eased with REAL dt so it
    // banks in at full speed during slow-mo, then unwinds on landing (target → 0).
    diveLean += (diveLeanTarget - diveLean) * (1 - Math.exp(-CFG.diveLeanRate * rdt));

    // incoming-hit view-kick recovers back to neutral
    hurtPitch += -hurtPitch * (1 - Math.exp(-CFG.hurtKickRecover * dt));
    hurtRoll += -hurtRoll * (1 - Math.exp(-CFG.hurtKickRecover * dt));

    fovKick += -fovKick * (1 - Math.exp(-CFG.fovRecover * dt));
    const fovTarget =
      baseFov + rush * CFG.fovBoost + speedFactor * CFG.fovSpeed + fovKick;
    camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-CFG.fovRate * dt));

    // ---- APPLY (fx.shake, if present, layers on top after this in main's order) ----
    if (camera.rotation) {
      camera.rotation.x = pitch + landKick + hurtPitch;
      camera.rotation.y = yaw;
      camera.rotation.z = roll + hurtRoll + diveLean;
    }
    camera.position.set(
      _pos.x + rX * bobX,
      _pos.y + bobY - dip + heightOffset,
      _pos.z + rZ * bobX
    );

    wasCrouch = crouchHeld; // edge-detect for next frame's slide trigger
  }

  // ---- shootdodge dive ----
  // Launch a committed ballistic leap in the queued strafe direction. Spends FOCUS,
  // grants i-frames, and drops the WORLD into slow-mo while the arc + look + fire run
  // at real rate. fX/fZ = facing basis, rX/rZ = right basis (already computed in step).
  function launchDive(q, fX, fZ, rX, rZ) {
    let qx = fX * (q.iz || 0) + rX * q.ix;
    let qz = fZ * (q.iz || 0) + rZ * q.ix;
    let ql = Math.hypot(qx, qz);
    if (ql < 1e-4) {
      qx = fX;
      qz = fZ;
      ql = 1;
    } // degenerate → leap along aim
    qx /= ql;
    qz /= ql;

    diveVel.set(qx * CFG.diveLaunchSpeed, CFG.diveLaunchUp, qz * CFG.diveLaunchSpeed);
    vel.set(0, 0, 0); // the dive owns motion; drop any ground momentum
    if (sliding) endSlide();

    diving = true;
    diveTime = 0;
    // the dive SOLELY owns invuln — clear any stale dash i-frames/flag so they can't
    // flip state.invuln off mid-air before touchdown.
    dashTimer = 0;
    iframeTimer = 0;
    if (state) {
      state.diving = true;
      state.invuln = true;
      state.dashing = false;
      state.focus = clamp((state.focus || 0) - CFG.diveCost, 0, 1);
    }

    // camera: widen FOV + bank toward the dive direction (lean into the leap)
    fovKick = Math.max(fovKick, CFG.diveFovKick);
    const rdot = qx * rX + qz * rZ; // dive component along camera-right
    diveLeanTarget = -Math.sign(rdot || 0) * CFG.diveRoll;

    // decoupled slow-mo: world crawls for the airtime + a tail covering the recovery.
    const airtime = (2 * CFG.diveLaunchUp) / CFG.diveGravity;
    ctx.fx && ctx.fx.slowmo && ctx.fx.slowmo(CFG.diveSlowScale, airtime + CFG.diveSlowExtra);

    bus && bus.emit && bus.emit("dive", { x: qx, z: qz });
    bus && bus.emit && bus.emit("announce", { text: "SHOOTDODGE", tone: "focus" });
  }

  // Touchdown → drop i-frames, enter the slowed/vulnerable recovery, thud the camera.
  function endDive() {
    if (!diving) return;
    diving = false;
    diveTime = 0;
    if (state) {
      state.diving = false;
      state.invuln = false; // i-frames END on landing — the risk that balances the dive
    }
    recover = CFG.landRecovery;
    diveLeanTarget = 0;
    // carry a little horizontal momentum into a landing skid; kill the vertical
    vel.set(diveVel.x * CFG.diveLandSkid, 0, diveVel.z * CFG.diveLandSkid);
    diveVel.set(0, 0, 0);
    // land thud: camera dip + pitch nudge + a small shake
    dip = Math.min(CFG.diveLaunchUp * CFG.dipScale * 2, CFG.dipMax);
    landKick = Math.min(CFG.diveLaunchUp * CFG.landPitch, CFG.landPitchMax);
    ctx.fx && ctx.fx.shake && ctx.fx.shake(CFG.landThud);
    bus && bus.emit && bus.emit("land", { impact: CFG.diveLaunchUp });
  }

  // FOCUS (dive fuel) fills from neutralizes.
  function onKill() {
    if (disposed || !state) return;
    state.focus = clamp((state.focus || 0) + CFG.focusPerKill, 0, 1);
  }

  // End a slide and start its cooldown. Safe to call when not sliding.
  function endSlide() {
    if (!sliding) return;
    sliding = false;
    slideTimer = 0;
    slideCd = CFG.slideCooldown;
    if (state) state.sliding = false;
  }

  // ---- lifecycle -------------------------------------------------------------
  function reset() {
    _pos.copyFrom(spawnPos);
    baseY = spawnPos.y;
    vel.set(0, 0, 0);
    yaw = spawnYaw;
    pitch = 0;
    roll = 0;
    dip = landKick = rush = fovKick = 0;
    bobPhase = 0;
    _speed = 0;
    dashTimer = dashCd = iframeTimer = coyote = jumpBuffer = 0;
    sliding = crouchActive = false;
    slideTimer = slideCd = 0;
    wasCrouch = false;
    heightOffset = 0;
    hurtPitch = hurtRoll = 0;
    hurtQueue.length = 0;
    dashQueued = null;
    diveQueued = null;
    diving = false;
    diveTime = 0;
    recover = 0;
    diveLean = diveLeanTarget = 0;
    diveVel.set(0, 0, 0);
    look.dx = look.dy = 0;
    pressed.clear();
    camera.fov = baseFov;
    if (state) {
      state.invuln = false;
      state.dashing = false;
      state.diving = false;
      state.sliding = false;
      state.crouching = false;
      state.focus = CFG.focusStart;
    }
  }

  // re-arm the player on each run (init order puts controller before "start")
  const busOff = [];
  const bindBus = (name, fn) => {
    if (!bus || !bus.on) return;
    const r = bus.on(name, fn);
    if (typeof r === "function") busOff.push(r);
    else if (bus.off) busOff.push(() => bus.off(name, fn));
  };
  bindBus("start", reset);
  bindBus("hurt", onHurt);
  bindBus("kill", onKill); // FOCUS (dive fuel) fills from neutralizes

  const off = onFrame && onFrame(step);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof off === "function") off();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    canvas.removeEventListener("pointerdown", onCanvasDown);
    for (const fn of busOff) fn && fn();
    busOff.length = 0;
    hurtQueue.length = 0;
    if (document.pointerLockElement === canvas && document.exitPointerLock)
      document.exitPointerLock();
    if (state) {
      state.invuln = false;
      state.dashing = false;
      state.diving = false;
      state.sliding = false;
      state.crouching = false;
    }
    camera.fov = baseFov;
  }

  return {
    update: step,
    reset,
    dispose,
    get speed() {
      return _speed;
    },
    get diving() {
      return diving;
    },
    get focus() {
      return state ? state.focus || 0 : 0;
    },
    get sliding() {
      return sliding;
    },
    get grounded() {
      return _pos.y <= baseY + 1e-3;
    },
  };
}

// ---- helpers ----------------------------------------------------------------
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
