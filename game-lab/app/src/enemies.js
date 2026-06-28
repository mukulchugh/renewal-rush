// enemies.js — Renewal Rush · ARMED SMART CHURN-AI AGENTS + ragdoll physics + director.
//
// Combat model v2 (DESIGN.md §0): enemies are no longer passive walkers. Every churn
// SIGNAL is a full-body low-poly HUMANOID AVATAR that carries a RANGED WEAPON and runs a
// real-time bot brain (no LLM) — the dynamic firefight feel of CS/Valorant/PUBG bots,
// with a Quivly skin. Tiers (Critical/High/Medium by score bucket) now mean how
// AGGRESSIVE / ACCURATE / TANKY / FAST-FIRING an agent is — NOT a "don't-shoot" flag.
// There is NO healthy/ally type anymore: every agent on screen is a hostile, valid target.
//
// ── What each agent does ───────────────────────────────────────────────────────
//   • PERCEPTION: distance + line-of-sight to the player (scene.pickWithRay against the
//     city's buildings/walls as occluders), staggered round-robin a few agents/frame, with
//     a last-known-position memory. (Analytic segment-vs-AABB fallback if a build ever makes
//     buildings unpickable — see the start-probe.)
//   • BRAIN (utility/FSM): ADVANCE (close the distance / reacquire) · ENGAGE (hold range,
//     circle-strafe, peek & fire) · TAKE COVER (move to break the player's LOS behind a
//     building) · FLANK (approach from a side angle, not a straight line) · RETREAT (back
//     off when low HP). Light separation steering so they don't stack.
//   • WEAPON: each agent AIMS then FIRES on a cadence — a clear TELEGRAPH first (weapon
//     raised + a red aim-laser + a wind-up beat = the dodge window), then a hitscan shot
//     with a tracer + muzzle flash. A hit emits bus "hurt" {amount} (drains the health bar).
//     Shots are DODGEABLE: break line-of-sight, strafe, or dash (i-frames) and they miss.
//     Accuracy / fire-rate / damage scale by bucket (Critical deadliest).
//   • OBJECTIVE / SIEGE: an agent that slips past (ages out) or reaches the Renewal Gate
//     line still calls game.signalEscaped → an account churns (threat ↑, health ↓). This is
//     the economic workhorse that keeps the director's threat/health loop alive.
//   • BANTER: cheap state-keyed callout pools emitted on bus "callout" {text, kind} at key
//     beats (spotting you, flanking, an agent down, an account going dark), globally throttled.
//   • DEATH: the procedural physics RAGDOLL (4 styles) is unchanged — parts detach and tumble.
//
// ⚠️ Difficulty + color come from the SCORE BUCKET, never the risk word (inverted):
//   Critical 0–24 red · High 25–49 orange · Medium 50–74 amber. The bucket drives hp /
//   speed / weapon stats / avatar tint (via brand RISK_TIERS, grounding-exact hexes).
//
// ── Difficulty director (DESIGN.md §3) ─────────────────────────────────────────
//   tension = f(game.elapsed, threat, combo). We read game.elapsed (ms) — NOT timeLeft —
//   because timeLeft pins at 0 in Overtime; tension must climb uncapped through Act 2.
//   Spawn interval + hp/speed/fire-rate scale with tension; the mix escalates by sector
//   Connect → See → Score → Act (floored by elapsed). Final 20s of renewal day = a
//   spawn-surge crescendo + the Critical renewal BOSS at the gate.
//
// ── Determinism (two streams, deliberately) ────────────────────────────────────
//   SPAWN/DIRECTOR randomness uses game.rng (the seeded daily stream) and is drawn ONLY at
//   spawn/placement decision points — never per-frame — so a daily seed reproduces the spawn
//   pattern. ALL real-time BRAIN/WEAPON randomness (hit rolls, flank side, strafe flips,
//   banter, jitter) is player-driven (its timing/order depends on aim + movement) so it draws
//   from a SEPARATE seeded stream (fxRng = mulberry32 off the daily seed, reseeded on
//   "start"), exactly like the ragdoll stream. Mixing those into game.rng would shift the Nth
//   spawn pick per playthrough and destroy seed reproducibility. No Math.random anywhere.
//
// ── Perf budget ────────────────────────────────────────────────────────────────
//   ~10–15 active agents. LOS raycasts are staggered round-robin (a few agents/frame, cached
//   between checks). Incoming fire is bounded by a global FIRE-TOKEN governor + a concurrent-
//   telegraph cap — this is both the balance lever AND the "cap concurrent shots/raycasts"
//   perf lever. Separation is O(n²) but n is tiny. Shot tracers/flashes are small pooled sets.
//
// ── Contract resolution (ARCHITECTURE.md) ──────────────────────────────────────
//   combat ONLY raycasts + calls mesh.metadata.onHit(damage)->dead. We are the SOLE scorer.
//   Each avatar carries ONE pickable hit-capsule whose mesh.metadata = { kind, chips, onHit }.
//   kind ∈ {signal,elite,shielded,churn,boss} (champion rides as elite/shielded + a champion
//   flag on the kill payload). The metadata is nulled the instant an agent dies so a
//   disabled-but-metadata'd capsule can't keep blocking shots.
//     kill         → game.deploySignal({baseArr,chips}); emit "kill"
//                    {arr,kind,position,source,chips,signal,champion} + "combo"; RAGDOLL.
//     escape/expire/siege→ game.signalEscaped(sev,{champion?}); emit "escape"{severity,champion}; fade.
//     enemy fire   → telegraph then (on hit) "hurt"{amount,from} (main applies it via
//                    takeDamage, gated on dash i-frames; controller shoves you off `from`).
//     boss         → emit "boss"{active} on appear/leave/death (audio expects it).
//   Additive (idempotent HUD handlers): "mutator"{name} once at start, "overtime" once on the
//   renewal→Act-2 phase flip, "callout"{text,kind} banter (HUD has callout() but no
//   on("callout") yet — wire one to render it). We never emit "win" (brand owns the card).
//
// Importing "@babylonjs/core/Culling/ray" is load-bearing: it runs AddRayExtensions(Scene),
// which is what makes scene.pickWithRay() exist (else _WarnImport("Ray")). enemies is created
// before combat in the init order, so we import it here to be self-contained.

import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Ray } from "@babylonjs/core/Culling/ray";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate"; // C5: Havok ragdolls (only when ctx.useHavok)
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";

import { BUCKET_ARR, SIGNALS, mulberry32 } from "./game.js";
import { SIGNAL_META, RISK_TIERS } from "./brand.js";
import { createEnemyAI } from "./enemyai.js"; // Yuka steering: navmesh paths, arrive, separation, avoidance
import { spawnHuman } from "./humanavatar.js"; // real human glTF body (alive); primitives = death ragdoll

// ── tiny math (local; game.js stays pure / un-imported for these) ───────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const PI = Math.PI;
const hexC = (h) => Color3.FromHexString(h);

// The six canonical sources (mirrors game.js SIGNALS + brand SIGNAL_META + audio).
const SOURCES = SIGNALS;

// ── Timing / removal tuning ─────────────────────────────────────────────────────
const FADE_TIME = 0.34; // escape / expire dissolve (scale-down)
const BOSS_HP = 360; // base whale hp (combat damage-points; primary=34, AoE=64)

// ── Combat AI tuning (ALL the combat numbers live here — tune blind-safe) ────────
// Per-class ranged WEAPON stats. class = role==="boss" ? "boss" : role==="champion" ?
// "champion" : bucket. Critical is the deadliest (shortest telegraph, fastest, most damage,
// most accurate). damage is health-bar points; acc is the base hit chance at optimal range
// vs a stationary, in-LOS player (then scaled by distance falloff + the player's dodge).
const WEAPON = {
  medium:   { range: 40, telegraph: 0.80, cooldown: 3.0, damage: 5,  acc: 0.42 },
  high:     { range: 48, telegraph: 0.64, cooldown: 2.3, damage: 7,  acc: 0.55 },
  critical: { range: 56, telegraph: 0.50, cooldown: 1.7, damage: 10, acc: 0.70 },
  champion: { range: 50, telegraph: 0.62, cooldown: 2.2, damage: 8,  acc: 0.58 },
  boss:     { range: 64, telegraph: 0.78, cooldown: 1.5, damage: 15, acc: 0.62 },
};

// FSM states.
const ST = { ADVANCE: 0, ENGAGE: 1, COVER: 2, FLANK: 3, RETREAT: 4 };

// Brain cadence + steering.
const DECIDE_MIN = 0.28, DECIDE_MAX = 0.5; // re-decide interval per agent (s)
const LOS_PER_FRAME = 4; // staggered LOS raycasts per frame (round-robin)
const SEEN_FORGET = 2.6; // s after losing LOS before lastKnown is abandoned → push player
const SEP_R = 2.4, SEP_R2 = SEP_R * SEP_R, SEP_FORCE = 2.6; // separation (anti-stack)

// Ranged fire governor — bounds concurrent shots/raycasts AND keeps the firefight fair.
const FIRE_BUDGET_MAX = 4.0;
const FIRE_REGEN_BASE = 1.15; // tokens/sec at tension 0
const FIRE_REGEN_TENSION = 0.85; // extra tokens/sec per unit tension
const MAX_TELEGRAPH = 4; // max agents winding up a shot at once

// Hit model.
const DODGE_REF = 9.0; // player lateral speed (u/s) that fully erodes the movement-dodge term
const MIN_HIT_MOVING = 0.32; // floor on the movement-dodge multiplier (you can't be untouchable by jogging)
const SHOT_SPREAD = 1.6; // world-units of tracer spread on a miss near the player

// Telegraph length scales DOWN as the agent gets closer (point-blank ≈ unavoidable).
const TELE_NEAR = 0.42; // fraction of base telegraph at point-blank
const TELE_CLOSE = 4.0; // within this distance, accuracy is forced near-certain

// Banter throttle.
const CALLOUT_MIN = 1.1, CALLOUT_MAX = 2.0;

// ── Ragdoll physics tuning (a tiny fixed-step integrator — no physics engine) ────
const GRAV = -26; // units/s² — punchy
const AIR_DRAG = 0.12; // linear air drag (per second)
const ANG_DRAG = 0.55; // angular drag (per second)
const RESTITUTION = 0.38; // ground bounce
const GROUND_FRIC = 0.6; // tangential friction on bounce
const GROUND_ANG = 0.5; // angular damping on ground contact
const SETTLE_V2 = 0.16 * 0.16; // speed² below which a grounded part sleeps
const RAG_H = 1 / 60; // fixed physics timestep
const RAG_MAX_SUB = 3; // max substeps per frame (anti spiral-of-death)
const RAGDOLL_LIFE = 2.7; // seconds a ragdoll lingers before pooling
const RAG_FADE = 0.75; // last seconds of life spent fading out
const MAX_RAGDOLLS = 14; // concurrent ragdoll cap (perf)
const DEATH_STYLES = ["topple", "blast", "crumple", "launch"]; // permutations

// Per-bucket tuning. hp/speed are in combat damage-points / units-per-sec, scaled live by
// the director. tier = the brand RISK_TIERS key for the avatar tint.
// HP is in combat damage-points (player primary = 34/shot, AoE pulse = 64). Base body kills:
// medium ~2 shots, high ~3, critical ~4 — NO tier one-shot by a 34 body shot. A 64 AoE clean-
// one-shots a base-tension medium (skill/power reward). hpScale (see acquire) caps at ~×1.85,
// keeping even a max-tension critical ≤ ~6 body shots; Full-Stack chips / champion bumps add on top.
const BUCKET = {
  critical: { hp: 110, speed: 5.4, sev: 3, size: 1.18, tier: "critical" },
  high: { hp: 100, speed: 5.0, sev: 2, size: 1.08, tier: "high" },
  medium: { hp: 62, speed: 4.4, sev: 1, size: 1.0, tier: "medium" },
};

// Per-role behavior. aggression biases preferred engage range (higher = fights closer +
// flanks more), steerBonus = harder steering, speedBonus stacks on the bucket speed.
const ROLE = {
  signal: { aggression: 0.40, steerBonus: 0.4, speedBonus: 0.0, maxLife: 26 },
  seeker: { aggression: 0.80, steerBonus: 1.4, speedBonus: 1.0, maxLife: 22 },
  champion: { aggression: 0.55, steerBonus: 0.6, speedBonus: 0.4, maxLife: 17 },
  boss: { aggression: 0.45, steerBonus: 0.2, speedBonus: 0.0, maxLife: 34 },
};

// The real negative SIGNAL_TYPES → bucket / role / primary source. multiOk = may stack
// extra source chips into a Full-Stack card. (champion always stacks.)
const TEMPLATES = {
  declining_usage: { bucket: "medium", role: "signal", source: "Gong", multiOk: false },
  no_activity_30d: { bucket: "medium", role: "signal", source: "Slack", multiOk: false },
  negative_market_signal: { bucket: "medium", role: "signal", source: "Market", multiOk: true },
  payment_overdue: { bucket: "high", role: "signal", source: "Stripe", multiOk: true },
  negative_sentiment: { bucket: "high", role: "seeker", source: "Gong", multiOk: false },
  support_escalation: { bucket: "high", role: "seeker", source: "Zendesk", multiOk: false },
  low_health_score: { bucket: "high", role: "seeker", source: "Stripe", multiOk: false },
  renewal_overdue: { bucket: "critical", role: "signal", source: "CRM", multiOk: false },
  critical_health_score: { bucket: "critical", role: "seeker", source: "CRM", multiOk: false },
  champion_departure: { bucket: "high", role: "champion", source: "Slack", multiOk: true },
};

// Enemy mix per sector (Connect → See → Score → Act → Overtime). Weighted pools.
const SECTOR_POOLS = [
  [["declining_usage", 3], ["no_activity_30d", 2], ["negative_market_signal", 1.5]],
  [["declining_usage", 2], ["no_activity_30d", 2], ["negative_market_signal", 2], ["payment_overdue", 2], ["negative_sentiment", 1]],
  [["payment_overdue", 2], ["negative_sentiment", 2], ["support_escalation", 2], ["low_health_score", 2], ["champion_departure", 1.5], ["negative_market_signal", 1], ["declining_usage", 1]],
  [["low_health_score", 2], ["negative_sentiment", 1.5], ["support_escalation", 1.5], ["renewal_overdue", 2.5], ["critical_health_score", 2.5], ["champion_departure", 1.5], ["payment_overdue", 1]],
  [["critical_health_score", 3], ["renewal_overdue", 2.5], ["low_health_score", 2], ["negative_sentiment", 2], ["support_escalation", 2], ["champion_departure", 2], ["payment_overdue", 1.5]],
];

// Full-Stack upgrade chance per sector.
const MULTI_P = [0, 0.12, 0.28, 0.34, 0.42];
const ZONE_INDEX = { connect: 0, see: 1, score: 2, act: 3 };

// Signal-type → product CATEGORY (the grounding's source categories, for the badge kicker).
const SIGNAL_CATEGORY = {
  declining_usage: "Usage", low_product_adoption: "Usage",
  payment_overdue: "Revenue",
  renewal_overdue: "CRM", renewal_approaching: "CRM",
  negative_sentiment: "Calls",
  support_escalation: "Support",
  no_activity_30d: "Comms",
  negative_market_signal: "Market",
  champion_departure: "Champion",
  critical_health_score: "Health", low_health_score: "Health",
};

// ── Banter (state-keyed callout pools, throttled) ───────────────────────────────
const BANTER = {
  spot: ["Contact — CSM spotted", "Eyes on the rep", "Target acquired", "There's the agent"],
  flank: ["Flanking left", "Flanking right", "Going around", "Cutting them off"],
  retreat: ["Falling back", "I'm hit — regrouping", "Pulling out", "Need cover"],
  down: ["Agent down", "We lost one", "They got Riley", "One down — push"],
  churn: ["{acct}'s going dark!", "{acct} is slipping", "{acct} just churned", "We took {acct}"],
};
const BANTER_KIND = { spot: "risk", flank: "warning", retreat: "accent", down: "warning", churn: "risk" };
const BANTER_ACCTS = ["Stribe", "Datablock", "Notiom", "Snowflurry", "Zendude", "Mixpander", "Slacky", "Gongster"];

const FONT = "Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif";

// ── Avatar skeleton constants (local space; root.scaling applies the per-avatar size) ──
const A = {
  headY: 1.66, headR: 0.2,
  neckY: 1.5, neckR: 0.075, neckH: 0.17,
  torsoY: 1.14, torsoR: 0.2, torsoH: 0.66, // rounded (capsule) chest, tapered not blocky
  shoulderY: 1.38, shoulderX: 0.3, armLen: 0.62, armR: 0.085,
  hipY: 0.84, hipX: 0.13, legLen: 0.8, legR: 0.115,
  hitY: 0.95, hitR: 0.46, hitH: 1.78,
  badgeY: 2.2, badgeW: 1.05, badgeH: 0.42,
  barY: 1.96, // per-NPC health bar — between the head and the badge
};

export function createEnemies(ctx) {
  const scene = ctx?.scene;
  const camera = ctx?.camera;
  const bus = ctx?.bus;
  const game = ctx?.game;
  if (!scene || !camera || !game) {
    return { update() {}, dispose() {}, list: () => [] };
  }

  // C5: when Havok is on, ragdoll parts become dynamic rigid bodies (stepped by main's
  // pe._step at scaled dt → they slow in bullet-time). Else the hand-rolled integrator runs.
  const useHavok = !!(ctx.useHavok && scene.getPhysicsEngine && scene.getPhysicsEngine());

  let disposed = false;
  let uid = 0;

  // Cosmetic / ragdoll / BRAIN PRNG — seeded but separate from game.rng (see header note).
  const seedBase = (typeof game.seed === "number" ? game.seed : hashStr(String(ctx.dailySeed || "rr"))) >>> 0;
  let fxRng = mulberry32((seedBase ^ 0x1b56c4f9) >>> 0 || 1);
  const fr = () => fxRng();
  const frRange = (lo, hi) => lo + (hi - lo) * fxRng();

  // Avatars are pooled by SKIN key (bucket / champion / boss).
  const SKIN = {
    medium: { tier: "medium", gold: false, crown: false, suitScale: 0.82 },
    high: { tier: "high", gold: false, crown: false, suitScale: 0.82 },
    critical: { tier: "critical", gold: false, crown: false, suitScale: 0.8 },
    champion: { tier: "high", gold: true, crown: true, suitScale: 0.55 },
    boss: { tier: "boss", gold: false, crown: true, suitScale: 0.7 },
  };

  const pools = {}; // skinKey -> [ent]
  const rigs = []; // every ent built (for dispose)
  const active = []; // currently spawned ents (alive or removing)
  const ragdolls = []; // ents in ragdoll removal (substep integrated)
  let ragAcc = 0; // fixed-timestep accumulator

  // Shared materials (cheap, batched). Per-rig only the small chest CORE has its own material.
  const mats = [];
  const texes = [];
  const trackMat = (m) => (mats.push(m), m);

  const skinMat = trackMat(new StandardMaterial("rr_av_skin", scene));
  skinMat.diffuseColor = new Color3(0.78, 0.62, 0.49);
  skinMat.specularColor = new Color3(0.08, 0.08, 0.08);

  const goldMat = trackMat(new StandardMaterial("rr_av_gold", scene));
  goldMat.disableLighting = true;
  goldMat.emissiveColor = hexC("#FBBF24");

  const shadowMat = trackMat(new StandardMaterial("rr_av_shadow", scene));
  shadowMat.disableLighting = true;
  shadowMat.diffuseColor = new Color3(0, 0, 0);
  shadowMat.specularColor = new Color3(0, 0, 0);
  shadowMat.emissiveColor = new Color3(0, 0, 0);
  shadowMat.alpha = 0.32;

  // Weapon materials — a dark sidearm with a hot emissive muzzle (shared across all rigs).
  const weaponBodyMat = trackMat(new StandardMaterial("rr_av_wbody", scene));
  weaponBodyMat.diffuseColor = new Color3(0.07, 0.07, 0.09);
  weaponBodyMat.specularColor = new Color3(0.18, 0.18, 0.22);
  const weaponTipMat = trackMat(new StandardMaterial("rr_av_wtip", scene));
  weaponTipMat.disableLighting = true;
  weaponTipMat.emissiveColor = hexC("#F97316");

  // Boots / gun-grip — matte dark gunmetal (shared).
  const gearMat = trackMat(new StandardMaterial("rr_av_gear", scene));
  gearMat.diffuseColor = new Color3(0.05, 0.05, 0.07);
  gearMat.specularColor = new Color3(0.12, 0.12, 0.16);

  // Helmet visor — a faint glowing tactical slit (reads as a "face" / agent visor; shared).
  const visorMat = trackMat(new StandardMaterial("rr_av_visor", scene));
  visorMat.disableLighting = true;
  visorMat.emissiveColor = hexC("#22D3EE").scale(0.7);

  // Per-NPC health bar — shared dark backing (the fill is per-rig for its own color/level).
  const barBgMat = trackMat(new StandardMaterial("rr_av_hpbg", scene));
  barBgMat.disableLighting = true;
  barBgMat.emissiveColor = new Color3(0.03, 0.03, 0.04);
  barBgMat.alpha = 0.82;
  const BAR_GREEN = hexC("#22C55E"), BAR_AMBER = hexC("#F59E0B"), BAR_RED = hexC("#EF4444");

  // Aim-laser material (the telegraph sight). One shared material; per-mesh visibility ramps.
  const aimMat = trackMat(new StandardMaterial("rr_av_aim", scene));
  aimMat.disableLighting = true;
  aimMat.emissiveColor = hexC("#FB3B3B");
  aimMat.alpha = 0.85;
  aimMat.backFaceCulling = false;

  // Suit material per skin (torso + limbs).
  const suitMats = {};
  for (const key in SKIN) {
    const cfg = SKIN[key];
    const base = hexC(RISK_TIERS[cfg.tier]?.color || "#EAB308");
    const m = trackMat(new StandardMaterial(`rr_av_suit_${key}`, scene));
    if (cfg.gold) {
      m.diffuseColor = new Color3(0.16, 0.15, 0.2); // champion: dark suit (gold rides on top)
    } else {
      m.diffuseColor = base.scale(cfg.suitScale);
    }
    m.specularColor = new Color3(0.1, 0.1, 0.12);
    suitMats[key] = m;
  }

  // Per-tier beam color (enemy tracers + aim accents read by threat tier).
  const tierBeamCol = {
    critical: hexC("#EF4444"), high: hexC("#F97316"), medium: hexC("#F59E0B"),
    champion: hexC("#FBBF24"), boss: hexC("#FB7185"),
  };

  // Badge texture/material cache keyed by the full visual signature.
  const badgeCache = new Map();

  // Per-frame scratch (allocation-free hot path). FX scratch kept separate from ragdoll
  // scratch (_axis/_qd) because shot-orientation runs in the same frame as ragdoll substeps.
  const _wScale = new Vector3();
  const _wPos = new Vector3();
  const _wQuat = new Quaternion();
  const _axis = new Vector3();
  const _qd = new Quaternion();
  const _qt = new Quaternion();
  const _c3 = new Color3();
  const _fxAxis = new Vector3();
  const _fxQuat = new Quaternion();
  const _UPv = new Vector3(0, 1, 0);
  const _mz = new Vector3();

  // Director / wave state.
  let spawnAcc = 0;
  let spawnInterval = 0.9;
  let zoneSector = 0;
  let renewalBossDone = false;
  let nextOvertimeBossAt = Infinity;
  let bossActive = false;
  let bossEnt = null;
  let prevStatus = game.status;
  let prevPhase = game.phase;

  // Per-frame combat globals.
  let tensionNow = 0;
  let fireBudget = 2.0;
  let telegraphingCount = 0;
  let engageCount = 0; // squad: how many agents are crowding the player right now
  let calloutCd = 0;
  let losCursor = 0;
  let lastPx = 0, lastPy = 1.7, lastPz = 0;
  let prevPx = null, prevPz = null;
  const playerVel = { x: 0, z: 0 };

  // World bounds (read ctx.world.worldBounds; else a safe default matching world.js).
  const wb = ctx.world && ctx.world.worldBounds;
  const BOUNDS = {
    minX: numOr(wb?.minX, -148), maxX: numOr(wb?.maxX, 148),
    minZ: numOr(wb?.minZ, -8), maxZ: numOr(wb?.maxZ, 382),
  };
  const SIEGE_Z = BOUNDS.maxZ - 2; // the Renewal Gate line — reaching it churns an account

  // Cover / line-of-sight occluders (built lazily once — world is created before us).
  let occluders = null; // Set<Mesh> (buildings + walls)
  let enemyAI = null; // Yuka steering layer (lazily built once footprints exist)
  const _occPred = (m) => occluders && occluders.has(m);
  let footprints = []; // [{cx,cz,r,minx,maxx,minz,maxz}] building AABBs (cover targets + analytic LOS)
  let useRaycastLOS = true;

  // PLAYER POSITION SOURCE (TPS retarget): the controller now writes the visible avatar's
  // world position to ctx.state.playerPos each frame, so enemies aim at the CHARACTER, not the
  // over-the-shoulder camera behind it. Falls back to the camera if the controller hasn't
  // written yet (frame 0) or in a camera-only build. This single helper retargets every
  // player-position read below (distance/LOS/aim @step, spawn placement, ragdoll blast dir).
  const playerPos = () => (ctx.state && ctx.state.playerPos) || camera.globalPosition || camera.position;
  const playerX = () => playerPos().x;
  const playerY = () => playerPos().y;
  const playerZ = () => playerPos().z;
  const readFlag = (v, d) => (v == null ? d : typeof v === "function" ? !!v() : !!v);

  function buildOccluders() {
    if (occluders) return;
    occluders = new Set();
    footprints = [];
    const list = scene.meshes || [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const n = (m && m.name) || "";
      if (n.indexOf("world_hq_") === 0 || n.indexOf("world_wall_") === 0) {
        occluders.add(m);
        if (n.indexOf("world_hq_") === 0) {
          try {
            m.computeWorldMatrix(true);
            const bb = m.getBoundingInfo().boundingBox;
            const mn = bb.minimumWorld, mx = bb.maximumWorld;
            footprints.push({
              cx: (mn.x + mx.x) / 2, cz: (mn.z + mx.z) / 2,
              r: Math.max(mx.x - mn.x, mx.z - mn.z) / 2,
              minx: mn.x, maxx: mx.x, minz: mn.z, maxz: mx.z,
            });
          } catch (_) {}
        }
      }
    }
    useRaycastLOS = probeRaycast();
  }

  // Definitive runtime probe: can a predicate-supplied ray pick an isPickable=false building?
  // (Babylon _internalPick skips the enabled/visible/pickable checks when a predicate is given
  // — the house pattern combat uses. We verify rather than assume; analytic LOS is the fallback.)
  function probeRaycast() {
    if (!footprints.length || !scene.pickWithRay) return false;
    const b = footprints[0];
    try {
      const o = new Vector3(b.minx - 5, 2.0, (b.minz + b.maxz) / 2);
      const d = new Vector3(1, 0, 0);
      const ray = new Ray(o, d, (b.maxx - b.minx) + 12);
      const pick = scene.pickWithRay(ray, _occPred);
      return !!(pick && pick.hit);
    } catch (_) {
      return false;
    }
  }

  // ── badge (small floating source/signal label above the head) ────────────────
  function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function humanize(s) {
    return String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function badgeFor(desc) {
    const key = desc.badgeKey;
    let entry = badgeCache.get(key);
    if (entry) return entry;

    uid += 1;
    const W = 360;
    const H = 144;
    const tex = new DynamicTexture(`rr_badge_t_${uid}`, { width: W, height: H }, scene, true);
    tex.hasAlpha = true;
    texes.push(tex);
    const g = tex.getContext();
    g.clearRect(0, 0, W, H);

    const tierCol = RISK_TIERS[desc.tier]?.color || "#EAB308";
    const srcCol = (SIGNAL_META[desc.source] || SIGNAL_META.CRM).color;
    const champ = desc.role === "champion";
    const frameCol = champ ? "#FBBF24" : tierCol;

    g.fillStyle = "rgba(9,9,16,0.92)";
    roundRect(g, 6, 6, W - 12, H - 12, 22);
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = frameCol;
    g.shadowColor = frameCol;
    g.shadowBlur = 16;
    roundRect(g, 6, 6, W - 12, H - 12, 22);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = frameCol;
    roundRect(g, 14, 18, 9, H - 36, 4);
    g.fill();

    const cat = (SIGNAL_CATEGORY[desc.signalType] || "Signal").toUpperCase();
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.font = `700 22px ${FONT}`;
    g.fillStyle = srcCol;
    g.fillText(`${cat} · ${String(desc.source).toUpperCase()}`, 40, 48);

    g.font = `800 30px ${FONT}`;
    g.fillStyle = "#F1F2F7";
    let label = champ ? "CHAMPION LEAVING" : humanize(desc.signalType);
    if (g.measureText(label).width > W - 56) {
      while (label.length > 4 && g.measureText(label + "…").width > W - 56) label = label.slice(0, -1);
      label += "…";
    }
    g.fillText(label, 40, 86);

    g.font = `800 20px ${FONT}`;
    if (champ) {
      g.fillStyle = "#FBBF24";
      g.fillText("★ MUST-CATCH", 40, 120);
    } else if (desc.chips >= 3) {
      g.fillStyle = "#a5b4fc";
      g.fillText("◆ FULL STACK · 3 SOURCES", 40, 120);
    } else if (desc.chips >= 2) {
      g.fillStyle = "#a5b4fc";
      g.fillText("◆ 2 SOURCES", 40, 120);
    } else {
      g.fillStyle = "rgba(154,160,180,0.9)";
      g.fillText(RISK_TIERS[desc.tier]?.label || "AT RISK", 40, 120);
    }

    tex.update();

    const mat = trackMat(new StandardMaterial(`rr_badge_m_${uid}`, scene));
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveTexture = tex;
    mat.emissiveColor = Color3.White();
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    entry = { tex, mat };
    badgeCache.set(key, entry);
    return entry;
  }

  // ── avatar rig construction (pooled by skin key) ─────────────────────────────
  function makePart(mesh, parent, restPos, restRot, collR) {
    mesh.parent = parent;
    mesh.position.copyFrom(restPos);
    mesh.rotation.copyFrom(restRot);
    mesh.isPickable = false;
    mesh.rotationQuaternion = null; // euler during life; quaternion during ragdoll
    return {
      mesh, parent,
      restPos: restPos.clone(),
      restRot: restRot.clone(),
      collR,
      vel: new Vector3(),
      angVel: new Vector3(),
      quat: new Quaternion(),
      settled: false,
    };
  }

  function buildRig(skinKey) {
    uid += 1;
    const id = uid;
    const cfg = SKIN[skinKey];
    const suit = suitMats[skinKey];

    const root = new TransformNode(`rr_av_${id}`, scene);
    root.rotationQuaternion = null;
    root.setEnabled(false);

    const ZERO = Vector3.Zero();

    // Torso — a rounded (capsule) chest baked wider-than-deep, so the silhouette tapers
    // instead of reading as a box. Baking keeps it correct under the ragdoll's uniform scaling.
    const torso = MeshBuilder.CreateCapsule(`rr_torso_${id}`, { radius: A.torsoR, height: A.torsoH, tessellation: 8, capSubdivisions: 3 }, scene);
    torso.scaling.set(1.18, 1, 0.72); // broaden the shoulders, flatten the chest front-to-back
    torso.bakeCurrentTransformIntoVertices();
    torso.material = suit;
    const torsoPart = makePart(torso, root, new Vector3(0, A.torsoY, 0), ZERO, 0.24);

    // Pelvis + rounded shoulder pads — separate suit-tinted meshes that ride the torso bone.
    const pelvis = MeshBuilder.CreateCapsule(`rr_pelvis_${id}`, { radius: 0.15, height: 0.28, tessellation: 8, capSubdivisions: 2 }, scene);
    pelvis.rotation.z = PI / 2; pelvis.scaling.set(1, 1, 0.78); pelvis.material = suit; pelvis.parent = torso;
    pelvis.position.set(0, A.hipY - A.torsoY + 0.04, 0); pelvis.isPickable = false;
    const padL = MeshBuilder.CreateSphere(`rr_padL_${id}`, { diameter: 0.21, segments: 6 }, scene);
    const padR = MeshBuilder.CreateSphere(`rr_padR_${id}`, { diameter: 0.21, segments: 6 }, scene);
    padL.material = padR.material = suit; padL.parent = padR.parent = torso;
    padL.position.set(-A.shoulderX + 0.03, A.shoulderY - A.torsoY, 0);
    padR.position.set(A.shoulderX - 0.03, A.shoulderY - A.torsoY, 0);
    padL.isPickable = padR.isPickable = false;

    const coreMat = trackMat(new StandardMaterial(`rr_av_core_${id}`, scene));
    coreMat.disableLighting = true;
    const coreBase = cfg.gold ? hexC("#FBBF24") : hexC(RISK_TIERS[cfg.tier]?.color || "#EAB308");
    coreMat.emissiveColor = coreBase.clone();
    const core = MeshBuilder.CreateBox(`rr_core_${id}`, { width: 0.2, height: 0.14, depth: 0.06 }, scene);
    core.material = coreMat;
    core.parent = torso;
    core.position.set(0, 0.08, A.torsoR * 0.72 + 0.02);
    core.isPickable = false;

    // Short neck — a skin capsule riding the torso (the head detaches above it in ragdoll).
    const neck = MeshBuilder.CreateCapsule(`rr_neck_${id}`, { radius: A.neckR, height: A.neckH, tessellation: 6, capSubdivisions: 1 }, scene);
    neck.material = skinMat; neck.parent = torso;
    neck.position.set(0, A.neckY - A.torsoY, 0); neck.isPickable = false;

    const head = MeshBuilder.CreateSphere(`rr_head_${id}`, { diameter: A.headR * 2, segments: 8 }, scene);
    head.material = skinMat;
    const headPart = makePart(head, root, new Vector3(0, A.headY, 0), ZERO, A.headR);

    // Helmet (sphere-cap) + glowing visor slit — separate meshes that ride the head bone.
    const helmet = MeshBuilder.CreateSphere(`rr_helm_${id}`, { diameter: A.headR * 2.16, segments: 8, slice: 0.6 }, scene);
    helmet.material = suit; helmet.parent = head;
    helmet.position.set(0, -A.headR * 0.2, -0.012); helmet.isPickable = false;
    const visor = MeshBuilder.CreateBox(`rr_visor_${id}`, { width: A.headR * 1.5, height: A.headR * 0.5, depth: 0.06 }, scene);
    visor.material = visorMat; visor.parent = head;
    visor.position.set(0, A.headR * 0.12, A.headR * 0.88); visor.isPickable = false;

    let crown = null;
    if (cfg.crown) {
      crown = MeshBuilder.CreateTorus(`rr_crown_${id}`, { diameter: A.headR * 2.0, thickness: 0.05, tessellation: 10 }, scene);
      crown.material = goldMat;
      crown.parent = head;
      crown.position.set(0, A.headR * 1.18, 0);
      crown.isPickable = false;
    }

    const armRest = new Vector3(0, -A.armLen / 2, 0);
    const legRest = new Vector3(0, -A.legLen / 2, 0);

    const shL = new TransformNode(`rr_shL_${id}`, scene); shL.parent = root; shL.position.set(-A.shoulderX, A.shoulderY, 0);
    const shR = new TransformNode(`rr_shR_${id}`, scene); shR.parent = root; shR.position.set(A.shoulderX, A.shoulderY, 0);
    const hipL = new TransformNode(`rr_hipL_${id}`, scene); hipL.parent = root; hipL.position.set(-A.hipX, A.hipY, 0);
    const hipR = new TransformNode(`rr_hipR_${id}`, scene); hipR.parent = root; hipR.position.set(A.hipX, A.hipY, 0);

    const armL = MeshBuilder.CreateCapsule(`rr_armL_${id}`, { radius: A.armR, height: A.armLen, tessellation: 6, capSubdivisions: 2 }, scene);
    const armR = MeshBuilder.CreateCapsule(`rr_armR_${id}`, { radius: A.armR, height: A.armLen, tessellation: 6, capSubdivisions: 2 }, scene);
    const legL = MeshBuilder.CreateCapsule(`rr_legL_${id}`, { radius: A.legR, height: A.legLen, tessellation: 6, capSubdivisions: 2 }, scene);
    const legR = MeshBuilder.CreateCapsule(`rr_legR_${id}`, { radius: A.legR, height: A.legLen, tessellation: 6, capSubdivisions: 2 }, scene);
    armL.material = armR.material = legL.material = legR.material = suit;
    const armLPart = makePart(armL, shL, armRest, ZERO, A.armR + 0.02);
    const armRPart = makePart(armR, shR, armRest, ZERO, A.armR + 0.02);
    const legLPart = makePart(legL, hipL, legRest, ZERO, A.legR + 0.02);
    const legRPart = makePart(legR, hipR, legRest, ZERO, A.legR + 0.02);

    // Hands (skin spheres) + boots (dark) — separate meshes at the limb ends; ride the bone.
    const handL = MeshBuilder.CreateSphere(`rr_handL_${id}`, { diameter: 0.13, segments: 6 }, scene);
    const handR = MeshBuilder.CreateSphere(`rr_handR_${id}`, { diameter: 0.13, segments: 6 }, scene);
    handL.material = handR.material = skinMat;
    handL.parent = armL; handR.parent = armR;
    handL.position.set(0, -A.armLen / 2, 0); handR.position.set(0, -A.armLen / 2, 0);
    handL.isPickable = handR.isPickable = false;
    const footL = MeshBuilder.CreateBox(`rr_footL_${id}`, { width: 0.14, height: 0.1, depth: 0.27 }, scene);
    const footR = MeshBuilder.CreateBox(`rr_footR_${id}`, { width: 0.14, height: 0.1, depth: 0.27 }, scene);
    footL.material = footR.material = gearMat;
    footL.parent = legL; footR.parent = legR;
    footL.position.set(0, -A.legLen / 2 - 0.02, 0.06); footR.position.set(0, -A.legLen / 2 - 0.02, 0.06);
    footL.isPickable = footR.isPickable = false;

    // ── Agent deployer — a low-poly firearm (body + barrel + grip + sight) in the RIGHT hand ──
    // The arm capsule's −Y axis is the "reach": when the shoulder raises to aim, −Y swings
    // forward toward the player, so the barrel (laid along −Y) tracks the aim, and the whole
    // gun tumbles with armR during ragdoll. muzzleWorld() reads the emissive tip directly.
    const gun = new TransformNode(`rr_gun_${id}`, scene);
    gun.parent = armR;
    gun.position.set(0.045, -A.armLen / 2 - 0.05, 0.0);
    const gunBody = MeshBuilder.CreateBox(`rr_gbody_${id}`, { width: 0.07, height: 0.2, depth: 0.1 }, scene);
    gunBody.material = weaponBodyMat; gunBody.parent = gun; gunBody.position.set(0, -0.07, 0.02);
    gunBody.isPickable = false;
    const gunBarrel = MeshBuilder.CreateCylinder(`rr_gbar_${id}`, { height: 0.26, diameter: 0.05, tessellation: 8 }, scene);
    gunBarrel.material = weaponBodyMat; gunBarrel.parent = gun;
    gunBarrel.position.set(0, -0.26, 0.035); gunBarrel.isPickable = false; // cylinder axis Y == the −Y reach
    const gunGrip = MeshBuilder.CreateBox(`rr_ggrip_${id}`, { width: 0.055, height: 0.14, depth: 0.07 }, scene);
    gunGrip.material = gearMat; gunGrip.parent = gun;
    gunGrip.position.set(0, 0.04, -0.05); gunGrip.rotation.x = 0.45; gunGrip.isPickable = false;
    const gunSight = MeshBuilder.CreateBox(`rr_gsight_${id}`, { width: 0.03, height: 0.05, depth: 0.07 }, scene);
    gunSight.material = gearMat; gunSight.parent = gun;
    gunSight.position.set(0, -0.13, -0.045); gunSight.isPickable = false;
    const muzzle = MeshBuilder.CreateSphere(`rr_muz_${id}`, { diameter: 0.07, segments: 6 }, scene);
    muzzle.material = weaponTipMat; muzzle.parent = gun;
    muzzle.position.set(0, -0.41, 0.035); muzzle.isPickable = false;
    const weapon = gunBody; // ent.weapon ref for resetPose's enable/visibility restore

    const hit = MeshBuilder.CreateCapsule(`rr_hit_${id}`, { radius: A.hitR, height: A.hitH, tessellation: 6, capSubdivisions: 2 }, scene);
    hit.parent = root;
    hit.position.set(0, A.hitY, 0);
    hit.isVisible = false;
    hit.isPickable = true;

    const badge = MeshBuilder.CreatePlane(`rr_badge_${id}`, { width: A.badgeW, height: A.badgeH, sideOrientation: 2 }, scene);
    badge.parent = root;
    badge.position.set(0, A.badgeY, 0);
    badge.billboardMode = 2; // BILLBOARDMODE_Y
    badge.isPickable = false;

    const shadow = MeshBuilder.CreateDisc(`rr_shadow_${id}`, { radius: A.hitR * 0.95, tessellation: 16 }, scene);
    shadow.parent = root;
    shadow.rotation.x = PI / 2;
    shadow.position.set(0, 0.02, 0);
    shadow.material = shadowMat;
    shadow.isPickable = false;

    // Aim-laser sight (telegraph). UNPARENTED — oriented in world space toward the player.
    const aimLine = MeshBuilder.CreateCylinder(`rr_aim_${id}`, { height: 1, diameter: 0.04, tessellation: 5 }, scene);
    aimLine.material = aimMat;
    aimLine.isPickable = false;
    aimLine.rotationQuaternion = Quaternion.Identity();
    aimLine.setEnabled(false);

    // ── Per-NPC health bar — hidden at full HP, appears on first damage (see updateHpBar) ──
    // Champions/bosses get a wider, brighter bar. Fill is left-anchored (scaling.x = hpFrac) and
    // kept coplanar with the bg; zOffset (not a z position) biases it toward the camera so it
    // renders on top regardless of which way the billboard faces.
    const hpBarW = (cfg.gold || skinKey === "boss") ? 1.3 : 0.86;
    const hpBg = MeshBuilder.CreatePlane(`rr_hpbg_${id}`, { width: hpBarW, height: 0.11, sideOrientation: 2 }, scene);
    hpBg.parent = root; hpBg.position.set(0, A.barY, 0); hpBg.billboardMode = 2; // BILLBOARDMODE_Y
    hpBg.material = barBgMat; hpBg.isPickable = false; hpBg.setEnabled(false);
    const barFillMat = trackMat(new StandardMaterial(`rr_hpfill_${id}`, scene));
    barFillMat.disableLighting = true;
    barFillMat.emissiveColor = BAR_GREEN.clone();
    barFillMat.zOffset = -2; // depth bias toward camera so the fill never z-fights the bg
    const hpFill = MeshBuilder.CreatePlane(`rr_hpfill_${id}`, { width: hpBarW, height: 0.075, sideOrientation: 2 }, scene);
    hpFill.parent = hpBg; hpFill.position.set(0, 0, 0); hpFill.material = barFillMat; hpFill.isPickable = false;

    const parts = [torsoPart, headPart, armLPart, armRPart, legLPart, legRPart];
    // EVERY cosmetic mesh (not just the 6 ragdoll bones) must be here — the death fade and the
    // pool-reuse restore iterate ONLY this list, and Babylon's mesh.visibility does NOT inherit
    // from the parent bone. Anything omitted stays opaque while the body dissolves, then pops.
    const fadeMeshes = [
      torso, head, armL, armR, legL, legR, core,
      neck, pelvis, padL, padR, handL, handR, footL, footR, helmet, visor,
      gunBody, gunBarrel, gunGrip, gunSight, muzzle,
      hpBg, hpFill,
    ];
    if (crown) fadeMeshes.push(crown);

    const ent = {
      root, skinKey, parts, fadeMeshes,
      core, coreMat, coreBase: coreBase.clone(),
      crown, hit, badge, shadow, weapon, muzzle, aimLine,
      hpBg, hpFill, hpFillMat: barFillMat, hpBarW, hpBarBright: (cfg.gold || skinKey === "boss") ? 1.4 : 1.0,
      pivots: [
        { node: shL, kind: "arm", side: -1 },
        { node: shR, kind: "arm", side: 1 },
        { node: hipL, kind: "leg", side: -1 },
        { node: hipR, kind: "leg", side: 1 },
      ],
      torso,
      // identity (reset on every acquire)
      bucket: "medium", role: "signal", source: "CRM", chips: 1, kind: "signal", signalType: "",
      tier: "medium", sev: 1, baseArr: 0, size: 1,
      maxLife: 26, hp: 1, hpMax: 1, speed: 0,
      // motion
      vx: 0, vz: 0, age: 0, phase: 0, gait: 0, yaw: 0, flash: 0,
      // brain
      weapon_: WEAPON.medium, aggression: 0.4, steer: 3.5, preferredRange: 24,
      state: ST.ADVANCE, stateTime: 0, decideCd: 0,
      los: false, losInit: false, distToPlayer: 999, seenAge: 0,
      lastKnownX: 0, lastKnownZ: 0,
      coverTarget: null, flankSign: 1, strafeSign: 1, strafeCd: 0,
      // weapon runtime
      fireCd: 0, telegraphT: 0, telegraphMax: 0.6, spokeSpot: false,
      // lifecycle
      alive: false, removing: 0, removeMode: null, allSettled: false,
    };

    ent._meta = { kind: "signal", chips: 1, onHit: (dmg) => handleHit(ent, dmg) };

    // Real human body (the alive look). The primitive meshes below become the HIDDEN
    // death-ragdoll rig — shown only when the agent dies (beginRagdoll) or churns (fade).
    ent.bodyMeshes = [torso, head, armL, armR, legL, legR, core, neck, pelvis, padL, padR, handL, handR, footL, footR, helmet, visor];
    if (crown) ent.bodyMeshes.push(crown);
    ent.human = ctx.humanAsset
      ? spawnHuman(ctx.humanAsset, root, Vector3, { faceYaw: 0, gun, gunAsset: ctx.gunAsset, tint: coreBase })
      : null;
    if (ent.human) for (const m of ent.bodyMeshes) m.setEnabled(false);

    rigs.push(ent);
    return ent;
  }

  // ── descriptor builders (resolve a spawn into static visual + behavior data) ──
  function skinKeyFor(role, bucket) {
    if (role === "boss") return "boss";
    if (role === "champion") return "champion";
    return bucket; // critical | high | medium
  }

  function combatClassFor(role, bucket) {
    if (role === "boss") return "boss";
    if (role === "champion") return "champion";
    return bucket;
  }

  function audioKind(role, chips) {
    if (role === "boss") return "boss";
    if (role === "seeker") return "churn";
    return chips >= 3 ? "shielded" : chips >= 2 ? "elite" : "signal";
  }

  function finalizeDesc(d) {
    const b = BUCKET[d.bucket];
    d.skinKey = skinKeyFor(d.role, d.bucket);
    d.tier = d.role === "boss" ? "boss" : SKIN[d.skinKey].tier;
    d.size = d.role === "boss" ? 1.8 : d.role === "champion" ? 1.16 : b.size;
    d.sev = b.sev;
    d.kind = audioKind(d.role, d.chips);
    d.badgeKey = `${d.tier}|${d.source}|${d.chips}|${d.role === "champion" ? "C" : ""}|${d.signalType}`;
    return d;
  }

  function chipsFor(tpl, sector) {
    if (tpl.role === "champion") return game.rng() < 0.45 ? 3 : 2;
    if (!tpl.multiOk) return 1;
    const p = MULTI_P[Math.min(sector, MULTI_P.length - 1)];
    if (game.rng() < p) return game.rng() < 0.3 ? 3 : 2;
    return 1;
  }

  function descFor(signalType, sector) {
    const tpl = TEMPLATES[signalType];
    return finalizeDesc({ signalType, bucket: tpl.bucket, role: tpl.role, source: tpl.source, chips: chipsFor(tpl, sector) });
  }

  function bossDesc() {
    const source = SOURCES[game.randInt(0, SOURCES.length - 1)];
    return finalizeDesc({ signalType: "renewal_overdue", bucket: "critical", role: "boss", source, chips: 3 });
  }

  function weightedPick(pairs) {
    let total = 0;
    for (const p of pairs) total += p[1];
    let r = game.rng() * total;
    for (const p of pairs) if ((r -= p[1]) < 0) return p[0];
    return pairs[pairs.length - 1][0];
  }

  // ── acquire / release (pool by skin key; re-skin = badge swap + size) ─────────
  function acquire(desc, tension, d01) {
    const key = desc.skinKey;
    let ent = (pools[key] || (pools[key] = [])).pop();
    if (!ent) ent = buildRig(key);

    ent.bucket = desc.bucket;
    ent.role = desc.role;
    ent.source = desc.source;
    ent.chips = desc.chips;
    ent.kind = desc.kind;
    ent.signalType = desc.signalType;
    ent.tier = desc.tier;
    ent.sev = desc.sev;
    ent.size = desc.size;

    const role = ROLE[desc.role];
    const b = BUCKET[desc.bucket];
    ent.maxLife = role.maxLife;
    ent.aggression = role.aggression;

    const hpScale = (1 + Math.min(tension, 3) * 0.28) * (game.mutator?.hpMult || 1); // cap ~×1.85
    const speedScale = lerp(0.9, 1.5, d01) * (game.mutator?.speedMult || 1);

    if (desc.role === "boss") {
      ent.hp = Math.max(1, Math.round(BOSS_HP * hpScale));
    } else {
      const baseHp = b.hp + 34 * (desc.chips - 1); // Full Stack = tougher
      ent.hp = Math.max(1, Math.round(baseHp * hpScale));
    }
    ent.hpMax = ent.hp;
    ent.speed = (b.speed + role.speedBonus) * speedScale * frRange(0.92, 1.08);
    ent.steer = 3.2 + role.steerBonus + ent.aggression * 1.6;

    // Weapon class + preferred engage range (aggressive agents fight closer).
    ent.weapon_ = WEAPON[combatClassFor(desc.role, desc.bucket)] || WEAPON.medium;
    ent.preferredRange = ent.weapon_.range * lerp(0.72, 0.46, ent.aggression);

    ent.baseArr =
      (BUCKET_ARR[desc.bucket] || 0) *
      (desc.role === "champion" ? 2 : 1) *
      (desc.role === "boss" ? 2 : 1) *
      (game.mutator?.arrMult || 1);

    // Reset ALL motion + brain + weapon runtime (pooled agents must not carry stale state).
    ent.vx = 0; ent.vz = 0;
    ent.age = 0;
    ent.flash = 0;
    ent.phase = game.rng() * TAU; // gait phase — drawn once at spawn (deterministic)
    ent.gait = ent.phase;
    ent.state = ST.ADVANCE;
    ent.stateTime = 0;
    ent.decideCd = frRange(0.1, DECIDE_MAX);
    ent.los = false;
    ent.losInit = false;
    ent.distToPlayer = 999;
    ent.seenAge = 99;
    ent.coverTarget = null;
    ent.flankSign = fr() < 0.5 ? -1 : 1;
    ent.strafeSign = fr() < 0.5 ? -1 : 1;
    ent.strafeCd = frRange(1.2, 2.4);
    ent.fireCd = frRange(0.4, 1.2); // small spawn-in delay so fresh agents don't insta-fire
    ent.telegraphT = 0;
    ent.telegraphMax = ent.weapon_.telegraph;
    ent.spokeSpot = false;
    ent.alive = true;
    ent.removing = 0;
    ent.removeMode = null;
    ent.allSettled = false;

    ent.badge.material = badgeFor(desc).mat;
    ent.coreMat.emissiveColor.copyFrom(ent.coreBase);
    ent.root.scaling.setAll(ent.size);
    resetPose(ent);
    placeOnGround(ent, desc.role === "boss");

    ent.lastKnownX = playerX();
    ent.lastKnownZ = playerZ();

    // Yuka vehicle owns the live XZ transform (steering/separation/avoidance/paths). The FSM
    // still picks WHERE to go; Yuka decides HOW to get there. Released on death/escape so the
    // ragdoll/Havok body can take over the body (they never drive the same transform at once).
    ent.ai?.remove();
    ent.ai = enemyAI
      ? enemyAI.addAgent(ent.root.position.x, ent.root.position.z, {
          maxSpeed: ent.speed, maxForce: 12 + ent.steer * 6,
          sepRadius: SEP_R, sepWeight: SEP_FORCE,
        })
      : null;
    ent.repathCd = 0;

    ent.badge.setEnabled(true);
    ent.shadow.setEnabled(true);
    ent.aimLine.setEnabled(false);
    updateHpBar(ent); // full HP on reuse → bar hidden again (resetPose un-faded its visibility)
    ent._meta.kind = desc.kind;
    ent._meta.chips = desc.chips;
    ent.hit.metadata = ent._meta; // becomes a valid target ONLY now
    ent.root.setEnabled(true);

    active.push(ent);
    return ent;
  }

  function resetPose(ent) {
    for (const part of ent.parts) {
      const m = part.mesh;
      m.parent = part.parent;
      m.position.copyFrom(part.restPos);
      m.rotationQuaternion = null;
      m.rotation.copyFrom(part.restRot);
      m.scaling.setAll(1);
      m.visibility = 1;
      m.setEnabled(true);
      part.settled = false;
      part.vel.setAll(0);
      part.angVel.setAll(0);
    }
    if (ent.core) { ent.core.visibility = 1; ent.core.setEnabled(true); }
    if (ent.crown) { ent.crown.visibility = 1; ent.crown.setEnabled(true); }
    if (ent.weapon) { ent.weapon.visibility = 1; ent.weapon.setEnabled(true); }
    // Restore visibility on EVERY fade mesh (covers the weapon tip + any cosmetic child the
    // ragdoll fade dimmed — these aren't ragdoll "parts" so the loop above misses them).
    for (const m of ent.fadeMeshes) m.visibility = 1;
    for (const p of ent.pivots) p.node.rotation.set(0, 0, 0);
    ent.root.rotation.set(0, 0, 0);
    ent.root.position.y = 0;

    // Human present → alive look: show the human, hide the primitive (death-ragdoll) rig.
    if (ent.human) {
      for (const m of ent.bodyMeshes) m.setEnabled(false);
      ent.human.setEnabled(true);
      ent.human.setMoving(false);
    }
  }

  function release(ent) {
    ent.ai?.remove(); ent.ai = null; // backstop handoff (death/escape paths also clear it)
    ent.alive = false;
    ent.removing = 0;
    ent.removeMode = null;
    ent.allSettled = false;
    ent.telegraphT = 0;
    ent.hit.metadata = null; // never picked while pooled
    ent.aimLine.setEnabled(false);
    const ri = ragdolls.indexOf(ent);
    if (ri >= 0) ragdolls.splice(ri, 1);
    if (useHavok) { // tear down the dynamic bodies before parts are re-parented for pooling
      for (const part of ent.parts) {
        if (part._agg) { try { part._agg.dispose(); } catch { /* noop */ } part._agg = null; }
      }
    }
    resetPose(ent);
    ent.badge.setEnabled(false);
    ent.shadow.setEnabled(false);
    ent.root.setEnabled(false);
    const i = active.indexOf(ent);
    if (i >= 0) active.splice(i, 1);
    (pools[ent.skinKey] || (pools[ent.skinKey] = [])).push(ent);
  }

  // ── spawn placement: on the ground, ahead of the player, within world bounds ──
  function placeOnGround(ent, isBoss) {
    const cx = playerX();
    const cz = playerZ();
    let fx = 0, fz = 1;
    const ray = camera.getForwardRay ? camera.getForwardRay(1).direction : null;
    if (ray) { fx = ray.x; fz = ray.z; }
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = 0; fz = 1; }
    const rx = fz, rz = -fx; // ground-plane perpendicular

    const dist = isBoss ? frRange(46, 58) : frRange(28, 48);
    const lat = isBoss ? frRange(-6, 6) : frRange(-18, 18);
    let x = cx + fx * dist + rx * lat;
    let z = cz + fz * dist + rz * lat;
    x = clamp(x, BOUNDS.minX, BOUNDS.maxX);
    z = clamp(z, BOUNDS.minZ, BOUNDS.maxZ);

    ent.root.position.set(x, 0, z);
    let dx = cx - x, dz = cz - z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    ent.vx = dx * ent.speed * 0.5;
    ent.vz = dz * ent.speed * 0.5;
    ent.yaw = Math.atan2(dx, dz);
    ent.root.rotation.y = ent.yaw;
  }

  // Per-NPC health bar: hidden at full HP, shown on first damage. Fill is left-anchored
  // (scaling.x = hpFrac) and color-lerps green→amber→red. Called only on hit, never per-frame.
  function updateHpBar(ent) {
    const frac = clamp01(ent.hp / (ent.hpMax || 1));
    if (frac >= 0.999) { ent.hpBg.setEnabled(false); return; }
    ent.hpBg.setEnabled(true);
    ent.hpFill.scaling.x = Math.max(0.02, frac);
    ent.hpFill.position.x = -(ent.hpBarW * 0.5) * (1 - frac);
    const c = frac > 0.5
      ? Color3.Lerp(BAR_AMBER, BAR_GREEN, (frac - 0.5) * 2)
      : Color3.Lerp(BAR_RED, BAR_AMBER, frac * 2);
    ent.hpFillMat.emissiveColor.copyFrom(c).scaleInPlace(ent.hpBarBright || 1);
  }

  // ── hit resolution (combat → metadata.onHit) ─────────────────────────────────
  function handleHit(ent, damage) {
    if (!ent || !ent.alive || ent.removing > 0) return false;
    ent.flash = 1;

    ent.hp -= damage || 1;
    updateHpBar(ent); // reflect the new HP on the floating bar (and reveal it on first hit)
    if (ent.hp > 0) return false; // damaged, not neutralized

    ent.hit.metadata = null; // dead this instant: can't be re-picked mid-ragdoll
    const gain = game.deploySignal?.({ baseArr: ent.baseArr, chips: ent.chips }) || 0;
    const champion = ent.role === "champion";
    bus?.emit?.("kill", {
      arr: gain,
      kind: ent.kind, // {signal|elite|shielded|churn|boss}
      position: centerOf(ent),
      source: ent.source,
      chips: ent.chips,
      signal: ent.signalType,
      champion,
    });
    bus?.emit?.("combo", { combo: game.combo });
    if (ent.role === "boss") endBoss();
    else if (fr() < 0.5) maybeBanter("down", ent); // a teammate calls it out
    beginRagdoll(ent);
    return true; // dead
  }

  function centerOf(ent) {
    const p = ent.root.position;
    return new Vector3(p.x, p.y + A.torsoY * ent.size, p.z);
  }

  // An account churns: the agent slipped past (aged out) or reached the Renewal Gate line.
  function churnAway(ent) {
    ent.ai?.remove(); ent.ai = null; // stop steering — agent is leaving the field
    if (ent.human) { ent.human.setEnabled(false); for (const m of ent.bodyMeshes) m.setEnabled(true); }
    ent.hit.metadata = null;
    ent.telegraphT = 0;
    ent.aimLine.setEnabled(false);
    if (ent.role === "boss") { endBoss(); beginFade(ent); return; }
    const champ = ent.role === "champion";
    game.signalEscaped?.(ent.sev, champ ? { champion: true } : undefined);
    bus?.emit?.("escape", { severity: ent.sev, champion: champ });
    if (fr() < 0.6) maybeBanter("churn", ent);
    beginFade(ent);
  }

  function endBoss() {
    if (!bossActive) return;
    bossActive = false;
    bossEnt = null;
    bus?.emit?.("boss", { active: false });
  }

  // ── perception: line-of-sight (raycast, with analytic fallback) ──────────────
  function refreshLOS(ent, px, py, pz) {
    const s = ent.size;
    const ex = ent.root.position.x;
    const ey = ent.root.position.y + A.shoulderY * s;
    const ez = ent.root.position.z;
    const dx = px - ex, dy = py - ey, dz = pz - ez;
    const dist = Math.hypot(dx, dz);
    const d3 = Math.hypot(dx, dy, dz) || 1;

    let blocked = false;
    if (footprints.length) {
      if (useRaycastLOS && scene.pickWithRay) {
        _mz.set(dx / d3, dy / d3, dz / d3);
        const o = new Vector3(ex, ey, ez);
        const ray = new Ray(o, _mz, d3 - 0.6);
        const pick = scene.pickWithRay(ray, _occPred);
        blocked = !!(pick && pick.hit && pick.distance < d3 - 0.6);
      } else {
        blocked = segBlockedXZ(ex, ez, px, pz);
      }
    }

    const wasLos = ent.los;
    ent.los = !blocked;
    ent.losInit = true;
    if (ent.los) {
      ent.lastKnownX = px;
      ent.lastKnownZ = pz;
      ent.seenAge = 0;
      if (!wasLos && !ent.spokeSpot && dist < ent.weapon_.range * 1.2) {
        ent.spokeSpot = true;
        if (fr() < 0.5) maybeBanter("spot", ent);
      }
    }
  }

  // Analytic 2D segment-vs-AABB fallback (identical perception result, cheaper). Skips the
  // building the agent is standing inside so cover-huggers can still peek out.
  function segBlockedXZ(x0, z0, x1, z1) {
    for (let i = 0; i < footprints.length; i++) {
      const b = footprints[i];
      if (x0 >= b.minx && x0 <= b.maxx && z0 >= b.minz && z0 <= b.maxz) continue; // inside it
      if (segAabb(x0, z0, x1, z1, b.minx, b.minz, b.maxx, b.maxz)) return true;
    }
    return false;
  }

  function segAabb(x0, z0, x1, z1, minx, minz, maxx, maxz) {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dz = z1 - z0;
    // slab X
    if (Math.abs(dx) < 1e-9) { if (x0 < minx || x0 > maxx) return false; }
    else {
      let ta = (minx - x0) / dx, tb = (maxx - x0) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    // slab Z
    if (Math.abs(dz) < 1e-9) { if (z0 < minz || z0 > maxz) return false; }
    else {
      let ta = (minz - z0) / dz, tb = (maxz - z0) / dz;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return t1 >= 0 && t0 <= 1;
  }

  function playerLateralSpeed(ent) {
    let dx = lastPx - ent.root.position.x, dz = lastPz - ent.root.position.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const perpx = -dz, perpz = dx; // perpendicular to the shot line
    return Math.abs(playerVel.x * perpx + playerVel.z * perpz);
  }

  // ── squad coordination ───────────────────────────────────────────────────────
  // Cap how many agents pile onto the player at once (scales with tension); the rest are
  // routed to FLANK instead, so a wave reads as a coordinated push — some engaging, others
  // arcing around — not a blob. An agent already engaging keeps its slot.
  function engageSlotFree(ent) {
    if (ent.state === ST.ENGAGE) return true;
    const cap = Math.max(2, Math.round(lerp(2, 6, clamp01(tensionNow))));
    return engageCount < cap;
  }

  // ── brain: utility/FSM transitions (runs on a cheap per-agent cadence) ────────
  function setState(ent, s) {
    if (ent.state === s) return;
    ent.state = s;
    ent.stateTime = 0;
    if (s === ST.ENGAGE) {
      engageCount++; // claim a slot the moment we engage (tightens the cap within a frame)
    } else if (s === ST.FLANK) {
      ent.flankSign = fr() < 0.5 ? -1 : 1; // keep the draw, then bias for fxRng stability
      // squad: prefer the less-crowded arc so two flankers don't stack on one side
      let left = 0, right = 0;
      for (const o of active) if (o !== ent && o.alive && o.state === ST.FLANK) (o.flankSign < 0 ? left++ : right++);
      if (left > right) ent.flankSign = -1; else if (right > left) ent.flankSign = 1;
      if (fr() < 0.4) maybeBanter("flank", ent);
    } else if (s === ST.COVER) {
      ent.coverTarget = findCover(ent);
    } else if (s === ST.RETREAT) {
      if (fr() < 0.45) maybeBanter("retreat", ent);
    }
  }

  function decide(ent) {
    const w = ent.weapon_;
    const hpFrac = ent.hp / (ent.hpMax || ent.hp || 1);
    const los = ent.los;
    const dist = ent.distToPlayer;

    // Low HP → back off (sometimes duck into cover instead).
    if (hpFrac < 0.3 && ent.state !== ST.RETREAT && ent.state !== ST.COVER) {
      setState(ent, fr() < 0.5 ? ST.RETREAT : ST.COVER);
      return;
    }
    if (ent.state === ST.RETREAT) {
      if (dist > w.range * 1.1 || ent.stateTime > 3.5) setState(ent, ST.ADVANCE);
      return;
    }
    if (ent.state === ST.COVER) {
      // hold cover briefly, then peek: re-engage if we can see, else push to reacquire.
      if (ent.stateTime > frRange(1.2, 2.4)) setState(ent, los ? ST.ENGAGE : ST.ADVANCE);
      return;
    }

    if (!los) {
      if (ent.seenAge > SEEN_FORGET) {
        setState(ent, ST.ADVANCE); // memory stale → push the player's actual position
      } else if (ent.state !== ST.FLANK && fr() < 0.3) {
        setState(ent, ST.FLANK); // try to come around the obstruction
      } else if (ent.state !== ST.FLANK) {
        setState(ent, ST.ADVANCE);
      }
      return;
    }

    // LOS true.
    if (dist > w.range) { setState(ent, ST.ADVANCE); return; }
    if (ent.state === ST.ADVANCE || ent.state === ST.FLANK) {
      // squad: engage if a slot is free, else flank in (don't all crowd the player at once).
      setState(ent, engageSlotFree(ent) ? ST.ENGAGE : ST.FLANK); return;
    }
    if (ent.state === ST.ENGAGE && ent.stateTime > frRange(3.5, 6)) {
      setState(ent, fr() < 0.5 ? ST.FLANK : ST.COVER); // reposition so the duel keeps moving
    }
  }

  // Pick a point on the far side of a nearby building from the player (break LOS).
  function findCover(ent) {
    if (!footprints.length) return null;
    const ex = ent.root.position.x, ez = ent.root.position.z;
    let best = null, bestD = Infinity;
    for (let i = 0; i < footprints.length; i++) {
      const b = footprints[i];
      let vx = b.cx - lastPx, vz = b.cz - lastPz;
      const vl = Math.hypot(vx, vz) || 1;
      vx /= vl; vz /= vl;
      const cxp = clamp(b.cx + vx * (b.r + 1.6), BOUNDS.minX, BOUNDS.maxX);
      const czp = clamp(b.cz + vz * (b.r + 1.6), BOUNDS.minZ, BOUNDS.maxZ);
      const d = Math.hypot(cxp - ex, czp - ez);
      if (d < bestD) { bestD = d; best = { x: cxp, z: czp }; }
    }
    return best;
  }

  // Desired move target by state (cheap; computed every frame from cached aim/targets).
  function moveTarget(ent, out) {
    const w = ent.weapon_;
    const ax = ent.los ? lastPx : ent.lastKnownX;
    const az = ent.los ? lastPz : ent.lastKnownZ;
    const ex = ent.root.position.x, ez = ent.root.position.z;
    let vx = ex - ax, vz = ez - az; // from aim → agent
    const d = Math.hypot(vx, vz) || 1;
    vx /= d; vz /= d;

    if (ent.state === ST.COVER && ent.coverTarget) {
      out.x = ent.coverTarget.x; out.z = ent.coverTarget.z; return;
    }
    if (ent.state === ST.RETREAT) {
      out.x = clamp(ax + vx * (w.range * 1.15), BOUNDS.minX, BOUNDS.maxX);
      out.z = clamp(az + vz * (w.range * 1.15), BOUNDS.minZ, BOUNDS.maxZ);
      return;
    }
    if (ent.state === ST.FLANK) {
      // rotate the (aim→agent) vector toward the flank side → an arcing side approach.
      const ang = ent.flankSign * 1.05;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = vx * ca - vz * sa, rz = vx * sa + vz * ca;
      out.x = clamp(ax + rx * (ent.preferredRange * 1.1), BOUNDS.minX, BOUNDS.maxX);
      out.z = clamp(az + rz * (ent.preferredRange * 1.1), BOUNDS.minZ, BOUNDS.maxZ);
      return;
    }
    if (ent.state === ST.ENGAGE) {
      // circle-strafe: hold preferred range but offset laterally around the player.
      const ang = ent.strafeSign * 0.5;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = vx * ca - vz * sa, rz = vx * sa + vz * ca;
      out.x = clamp(ax + rx * ent.preferredRange, BOUNDS.minX, BOUNDS.maxX);
      out.z = clamp(az + rz * ent.preferredRange, BOUNDS.minZ, BOUNDS.maxZ);
      return;
    }
    // ADVANCE: close to the preferred ring around the aim point.
    out.x = clamp(ax + vx * ent.preferredRange, BOUNDS.minX, BOUNDS.maxX);
    out.z = clamp(az + vz * ent.preferredRange, BOUNDS.minZ, BOUNDS.maxZ);
  }

  const _tgt = { x: 0, z: 0 };

  function steerTo(ent, tx, tz, dt, speedScale) {
    const p = ent.root.position;
    let dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) { dx /= d; dz /= d; }
    const arrive = d < 1.5 ? d / 1.5 : 1; // ease into the target ring (no jitter)
    let desx = dx * ent.speed * speedScale * arrive;
    let desz = dz * ent.speed * speedScale * arrive;

    // light separation so agents don't stack
    let sx = 0, sz = 0;
    for (let j = 0; j < active.length; j++) {
      const o = active[j];
      if (o === ent || !o.alive || o.removing > 0) continue;
      const ox = p.x - o.root.position.x, oz = p.z - o.root.position.z;
      const od2 = ox * ox + oz * oz;
      if (od2 > 1e-4 && od2 < SEP_R2) {
        const od = Math.sqrt(od2);
        const f = (SEP_R - od) / SEP_R;
        sx += (ox / od) * f; sz += (oz / od) * f;
      }
    }
    desx += sx * SEP_FORCE; desz += sz * SEP_FORCE;

    const k = Math.min(1, ent.steer * dt);
    ent.vx += (desx - ent.vx) * k;
    ent.vz += (desz - ent.vz) * k;
    p.x += ent.vx * dt;
    p.z += ent.vz * dt;
    p.x = clamp(p.x, BOUNDS.minX, BOUNDS.maxX);
    p.z = clamp(p.z, BOUNDS.minZ, BOUNDS.maxZ);
  }

  // ── weapon: telegraph → fire → cooldown ──────────────────────────────────────
  function weaponTick(ent, dt, px, py, pz) {
    const w = ent.weapon_;

    if (ent.telegraphT > 0) {
      ent.telegraphT -= dt;
      updateAimLine(ent, px, py, pz);
      if (ent.telegraphT <= 0) {
        fireShot(ent, px, py, pz);
        ent.aimLine.setEnabled(false);
        const scale = 1 / (1 + Math.min(tensionNow, 3) * 0.12); // hotter run = a touch faster
        ent.fireCd = w.cooldown * scale * frRange(0.9, 1.12);
      }
      return;
    }
    ent.aimLine.setEnabled(false);
    if (ent.fireCd > 0) { ent.fireCd -= dt; return; }

    // Eligible to open fire? (in LOS + in range + not hiding/fleeing + governor allows it)
    if (!ent.losInit || !ent.los) return;
    if (ent.distToPlayer > w.range * 1.05) return;
    if (ent.state === ST.COVER || ent.state === ST.RETREAT) return;
    if (telegraphingCount >= MAX_TELEGRAPH) return;
    if (fireBudget < 1) return;

    fireBudget -= 1;
    telegraphingCount += 1;
    // closer → shorter wind-up (point-blank is nearly unavoidable, but still telegraphed)
    const tFrac = clamp(ent.distToPlayer / w.range, TELE_NEAR, 1);
    ent.telegraphMax = w.telegraph * tFrac;
    ent.telegraphT = ent.telegraphMax;
  }

  function fireShot(ent, px, py, pz) {
    const w = ent.weapon_;
    const dist = ent.distToPlayer;
    const col = tierBeamCol[ent.tier] || tierBeamCol.high;
    muzzleWorld(ent, _mz);
    const mx = _mz.x, my = _mz.y, mz = _mz.z;

    let chance = w.acc;
    // distance falloff: full inside range*0.35, drops toward range
    const dn = clamp01((dist - w.range * 0.35) / (w.range * 0.8));
    chance *= lerp(1.0, 0.45, dn);
    if (dist < TELE_CLOSE) chance = Math.max(chance, 0.9); // point-blank
    // player movement dodge (strafing erodes accuracy; can't fully negate)
    const lateral = playerLateralSpeed(ent);
    chance *= clamp(1 - lateral / DODGE_REF, MIN_HIT_MOVING, 1);
    // hotter run nudges accuracy up a hair
    chance *= 1 + Math.min(tensionNow, 2) * 0.05;
    // LOS lost during the wind-up → guaranteed miss (you broke contact / took cover)
    if (!ent.los) chance = 0;

    const hit = ent.los && fr() < clamp01(chance);

    spawnFlash(mx, my, mz, col, 0.5 + ent.size * 0.4);
    if (hit) {
      spawnBeam(mx, my, mz, px, py, pz, col, 0.05);
      spawnFlash(px, py, pz, col, 0.6);
      let dmg = w.damage * (1 + Math.min(tensionNow, 3) * 0.1);
      bus?.emit?.("hurt", { amount: dmg, from: { x: ent.root.position.x, z: ent.root.position.z } });
    } else {
      // tracer streaks just past you — a clear "that one missed" read
      const ox = (fr() - 0.5) * 2 * SHOT_SPREAD;
      const oz = (fr() - 0.5) * 2 * SHOT_SPREAD;
      const oy = (fr() - 0.5) * SHOT_SPREAD;
      spawnBeam(mx, my, mz, px + ox, py + oy, pz + oz, col, 0.045);
    }
  }

  // World-space muzzle point — read straight off the gun's emissive tip so flashes + tracers
  // originate from the actual barrel and track the aim pose (one-frame lag is invisible).
  function muzzleWorld(ent, out) {
    const m = ent.muzzle;
    m.computeWorldMatrix(true);
    out.copyFrom(m.getAbsolutePosition());
  }

  function updateAimLine(ent, px, py, pz) {
    muzzleWorld(ent, _mz);
    const line = ent.aimLine;
    line.setEnabled(true);
    orientCyl(line, _mz.x, _mz.y, _mz.z, px, py, pz, 0.04 + 0.02 * ent.size);
    // ramp the laser in over the wind-up so it reads as "locking on"
    const t = 1 - clamp01(ent.telegraphT / (ent.telegraphMax || 1));
    line.visibility = 0.25 + 0.65 * t;
  }

  // ── shot FX pools (enemy tracers + muzzle/impact flashes) ────────────────────
  const TRACER_N = 14, FLASH_N = 14;
  const shotTracers = [];
  const shotFlashes = [];
  let trI = 0, flI = 0;
  for (let i = 0; i < TRACER_N; i++) {
    const mat = trackMat(new StandardMaterial(`rr_etrc_${i}`, scene));
    mat.disableLighting = true;
    mat.emissiveColor = tierBeamCol.high.clone();
    mat.alpha = 0;
    const mesh = MeshBuilder.CreateCylinder(`rr_etrcm_${i}`, { height: 1, diameter: 1, tessellation: 6 }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.rotationQuaternion = Quaternion.Identity();
    mesh.setEnabled(false);
    shotTracers.push({ mesh, mat, life: 0, maxLife: 1, active: false });
  }
  for (let i = 0; i < FLASH_N; i++) {
    const mat = trackMat(new StandardMaterial(`rr_efl_${i}`, scene));
    mat.disableLighting = true;
    mat.emissiveColor = tierBeamCol.high.clone();
    mat.alpha = 0;
    mat.backFaceCulling = false;
    const mesh = MeshBuilder.CreatePlane(`rr_eflm_${i}`, { size: 1 }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.billboardMode = 7; // BILLBOARDMODE_ALL
    mesh.setEnabled(false);
    shotFlashes.push({ mesh, mat, life: 0, maxLife: 1, active: false });
  }

  function spawnBeam(ax, ay, az, bx, by, bz, color, lifeSec) {
    const t = shotTracers[trI];
    trI = (trI + 1) % shotTracers.length;
    orientCyl(t.mesh, ax, ay, az, bx, by, bz, 0.05);
    t.mat.emissiveColor.copyFrom(color);
    t.mat.alpha = 1;
    t.life = lifeSec; t.maxLife = lifeSec; t.active = true;
    t.mesh.setEnabled(true);
  }

  function spawnFlash(x, y, z, color, size) {
    const f = shotFlashes[flI];
    flI = (flI + 1) % shotFlashes.length;
    f.mesh.position.set(x, y, z);
    f.mesh.scaling.setAll(size * (0.7 + fr() * 0.5));
    f.mesh.rotation.z = fr() * TAU;
    f.mat.emissiveColor.copyFrom(color);
    f.mat.alpha = 1;
    f.life = 0.07; f.maxLife = 0.07; f.active = true;
    f.mesh.setEnabled(true);
  }

  function updateShotFx(dt) {
    for (let i = 0; i < shotTracers.length; i++) {
      const t = shotTracers[i];
      if (!t.active) continue;
      t.life -= dt;
      const k = t.life > 0 ? t.life / t.maxLife : 0;
      t.mat.alpha = k;
      if (t.life <= 0) { t.active = false; t.mesh.setEnabled(false); }
    }
    for (let i = 0; i < shotFlashes.length; i++) {
      const f = shotFlashes[i];
      if (!f.active) continue;
      f.life -= dt;
      const k = f.life > 0 ? f.life / f.maxLife : 0;
      f.mat.alpha = k;
      if (f.life <= 0) { f.active = false; f.mesh.setEnabled(false); }
    }
  }

  // Orient a unit-height cylinder's +Y axis along (a→b), centered between them, scaled to length.
  function orientCyl(mesh, ax, ay, az, bx, by, bz, thick) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    const ix = dx / len, iy = dy / len, iz = dz / len;
    // axis = up × dir, with up = (0,1,0) → (iz, 0, -ix)
    const axx = iz, axy = 0, axz = -ix;
    const al = Math.hypot(axx, axy, axz);
    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new Quaternion();
    if (al < 1e-5) {
      Quaternion.RotationAxisToRef(_UPv, iy < 0 ? PI : 0, _fxQuat);
    } else {
      _fxAxis.set(axx / al, axy / al, axz / al);
      const dot = clamp(iy, -1, 1);
      Quaternion.RotationAxisToRef(_fxAxis, Math.acos(dot), _fxQuat);
    }
    mesh.rotationQuaternion.copyFrom(_fxQuat);
    mesh.scaling.set(thick, len, thick);
  }

  // ── banter ───────────────────────────────────────────────────────────────────
  function maybeBanter(kind, ent) {
    if (calloutCd > 0) return;
    const pool = BANTER[kind];
    if (!pool || !pool.length) return;
    let text = pool[(fr() * pool.length) | 0] || pool[0];
    if (text.indexOf("{acct}") >= 0) {
      text = text.replace("{acct}", BANTER_ACCTS[(fr() * BANTER_ACCTS.length) | 0] || "An account");
    }
    calloutCd = frRange(CALLOUT_MIN, CALLOUT_MAX);
    bus?.emit?.("callout", { text, kind: BANTER_KIND[kind] || "accent" });
  }

  // ── ragdoll launch (unchanged integrator): detach parts, impulse each, integrate ──
  function beginRagdoll(ent) {
    if (ent.removing > 0) return;
    if (ragdolls.length >= MAX_RAGDOLLS) release(ragdolls[0]);

    ent.ai?.remove(); ent.ai = null; // hand the body to the ragdoll/Havok — Yuka lets go
    // Death look: drop the human model, reveal the primitive parts for the ragdoll tumble.
    if (ent.human) { ent.human.setEnabled(false); for (const m of ent.bodyMeshes) m.setEnabled(true); }
    ent.alive = false;
    ent.removeMode = "ragdoll";
    ent.removing = RAGDOLL_LIFE;
    ent.allSettled = false;
    ent.telegraphT = 0;
    ent.aimLine.setEnabled(false);
    ent.badge.setEnabled(false);
    ent.shadow.setEnabled(false);

    const style = ent.role === "boss" ? "blast" : DEATH_STYLES[(fr() * DEATH_STYLES.length) | 0];

    let ax = ent.root.position.x - playerX();
    let az = ent.root.position.z - playerZ();
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;

    const rp = ent.root.position;
    const cyc = rp.y + A.torsoY * ent.size;
    const feetY = rp.y;
    const mag = 0.85 + 0.5 * fr();

    for (const part of ent.parts) {
      const m = part.mesh;
      m.computeWorldMatrix(true);
      m.getWorldMatrix().decompose(_wScale, _wQuat, _wPos);
      m.parent = null;
      m.position.copyFrom(_wPos);
      part.quat.copyFrom(_wQuat);
      m.rotationQuaternion = part.quat;
      m.scaling.setAll(ent.size);
      part.settled = false;

      let ox = _wPos.x - rp.x;
      let oy = _wPos.y - cyc;
      let oz = _wPos.z - rp.z;
      const ol = Math.hypot(ox, oy, oz) || 1;
      const nox = ox / ol, noy = oy / ol, noz = oz / ol;

      const v = part.vel; v.setAll(0);
      const w = part.angVel;

      if (style === "topple") {
        const ang = (2.6 + 1.4 * fr()) * mag;
        const axisX = -az, axisZ = ax;
        const rX = _wPos.x - rp.x, rY = _wPos.y - feetY, rZ = _wPos.z - rp.z;
        v.x = ang * (0 * rZ - axisZ * rY);
        v.y = ang * (axisZ * rX - axisX * rZ);
        v.z = ang * (axisX * rY - 0 * rX);
        v.x += ax * frRange(0.4, 1.2);
        v.z += az * frRange(0.4, 1.2);
        w.set((fr() - 0.5) * 4, (fr() - 0.5) * 4, (fr() - 0.5) * 4);
        w.x += axisX * ang; w.z += axisZ * ang;
      } else if (style === "blast") {
        const sp = (5 + 4 * fr()) * mag;
        v.x = (nox + ax * 0.6) * sp;
        v.y = Math.abs(noy) * sp * 0.5 + frRange(2.2, 4.2) * mag;
        v.z = (noz + az * 0.6) * sp;
        w.set((fr() - 0.5) * 26, (fr() - 0.5) * 26, (fr() - 0.5) * 26);
      } else if (style === "crumple") {
        const sp = (0.6 + 1.0 * fr()) * mag;
        v.x = nox * sp + ax * frRange(0.2, 0.7);
        v.y = frRange(-0.2, 0.7) * mag;
        v.z = noz * sp + az * frRange(0.2, 0.7);
        w.set((fr() - 0.5) * 7, (fr() - 0.5) * 7, (fr() - 0.5) * 7);
      } else {
        const up = (6 + 4 * fr()) * mag;
        v.x = ax * frRange(1.0, 2.6) + nox * frRange(0.5, 1.6);
        v.y = up;
        v.z = az * frRange(1.0, 2.6) + noz * frRange(0.5, 1.6);
        w.set((fr() - 0.5) * 18, (fr() - 0.5) * 18, (fr() - 0.5) * 18);
      }

      // C5: hand the part to Havok as a dynamic body, seeded with the SAME computed v/w.
      // NOTE: no fr()/frRange() below — adding an RNG draw here would desync the daily seed
      // (the fxRng stream also drives AI/banter). See the header determinism warning.
      if (useHavok) {
        try {
          const agg = new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: 1, restitution: RESTITUTION }, scene);
          agg.body.setLinearVelocity(v);
          agg.body.setAngularVelocity(w);
          part._agg = agg; // disposed in release()
        } catch { /* noop — fall through to nothing; mesh just stays put */ }
      }
    }

    ragdolls.push(ent);
  }

  function ragdollSubstep(h) {
    for (let r = 0; r < ragdolls.length; r++) {
      const ent = ragdolls[r];
      if (ent.allSettled) continue;
      let anyMoving = false;
      const sz = ent.size;
      for (const part of ent.parts) {
        if (part.settled) continue;
        anyMoving = true;
        const m = part.mesh;
        const v = part.vel;
        const w = part.angVel;

        v.y += GRAV * h;
        const ld = 1 - AIR_DRAG * h;
        v.x *= ld; v.y *= ld; v.z *= ld;

        m.position.x += v.x * h;
        m.position.y += v.y * h;
        m.position.z += v.z * h;

        const floor = part.collR * sz;
        if (m.position.y < floor) {
          m.position.y = floor;
          if (v.y < 0) v.y = -v.y * RESTITUTION;
          v.x *= GROUND_FRIC; v.z *= GROUND_FRIC;
          w.scaleInPlace(GROUND_ANG);
          if (v.x * v.x + v.y * v.y + v.z * v.z < SETTLE_V2 && w.lengthSquared() < 1.2) {
            v.setAll(0); w.setAll(0); part.settled = true;
          }
        }

        w.scaleInPlace(1 - ANG_DRAG * h);
        const wl = w.length();
        if (wl > 1e-4) {
          _axis.copyFrom(w).scaleInPlace(1 / wl);
          Quaternion.RotationAxisToRef(_axis, wl * h, _qd);
          _qd.multiplyToRef(part.quat, _qt);
          part.quat.copyFrom(_qt);
          part.quat.normalize();
        }
      }
      if (!anyMoving) ent.allSettled = true;
    }
  }

  // ── removal animations ───────────────────────────────────────────────────────
  function beginFade(ent, mode = "fade") {
    if (ent.removing > 0) return;
    ent.alive = false;
    ent.removeMode = mode;
    ent.removing = FADE_TIME;
    ent.telegraphT = 0;
    ent.aimLine.setEnabled(false);
    ent.hit.metadata = null;
  }

  function animateFade(ent, dt) {
    ent.removing -= dt;
    const t = clamp01(ent.removing / FADE_TIME);
    ent.root.scaling.setAll(ent.size * Math.max(0.02, t));
    if (ent.removing <= 0) release(ent);
  }

  function animateRagdoll(ent, dt) {
    ent.removing -= dt;
    if (ent.removing <= RAG_FADE) {
      const t = clamp01(ent.removing / RAG_FADE);
      for (const m of ent.fadeMeshes) m.visibility = t;
    }
    if (ent.removing <= 0) release(ent);
  }

  // ── per-entity step (alive avatars: perceive, decide, move, aim/fire, walk) ───
  function stepEntity(ent, dt, px, py, pz) {
    ent.age += dt;
    ent.stateTime += dt;
    if (ent.flash > 0) ent.flash = Math.max(0, ent.flash - dt / 0.18);

    // distance (cheap, every frame); LOS comes from the staggered refresh
    const ddx = px - ent.root.position.x, ddz = pz - ent.root.position.z;
    ent.distToPlayer = Math.hypot(ddx, ddz);
    if (!ent.los) ent.seenAge += dt;

    // brain cadence
    ent.decideCd -= dt;
    if (ent.decideCd <= 0) { decide(ent); ent.decideCd = frRange(DECIDE_MIN, DECIDE_MAX); }

    // strafe flip timer
    ent.strafeCd -= dt;
    if (ent.strafeCd <= 0) { ent.strafeSign = -ent.strafeSign; ent.strafeCd = frRange(1.2, 2.6); }

    // weapon (telegraph/fire) — before movement so the pose can read the telegraph
    weaponTick(ent, dt, px, py, pz);
    const telegraphing = ent.telegraphT > 0;

    // movement (hold mostly still while winding up the shot)
    moveTarget(ent, _tgt);
    if (ent.ai) {
      ent.ai.setMaxSpeed(ent.speed * (telegraphing ? 0.32 : 1));
      // Blind ADVANCE (no LOS, memory stale): route to last-known via the navmesh so the agent
      // searches AROUND buildings instead of beelining into a wall. Else Arrive to the FSM point.
      const blindAdvance = ent.state === ST.ADVANCE && !ent.los && ent.seenAge > SEEN_FORGET;
      ent.repathCd -= dt;
      if (blindAdvance) {
        if (ent.repathCd <= 0) {
          const path = enemyAI.pathTo(ent.root.position.x, ent.root.position.z, ent.lastKnownX, ent.lastKnownZ);
          if (!ent.ai.setPath(path)) ent.ai.setTarget(_tgt.x, _tgt.z); // no route → direct
          ent.repathCd = 0.6; // fixed cadence — no fxRng draw (keeps banter/ragdoll stream stable)
        }
      } else {
        ent.ai.setTarget(_tgt.x, _tgt.z);
      }
      // Read back the position Yuka integrated at the top of this frame; clamp to world bounds.
      const veh = ent.ai.vehicle;
      const cx = clamp(veh.position.x, BOUNDS.minX, BOUNDS.maxX);
      const cz = clamp(veh.position.z, BOUNDS.minZ, BOUNDS.maxZ);
      if (cx !== veh.position.x || cz !== veh.position.z) veh.position.set(cx, 0, cz);
      ent.root.position.x = cx; ent.root.position.z = cz;
      ent.vx = veh.velocity.x; ent.vz = veh.velocity.z;
    } else {
      steerTo(ent, _tgt.x, _tgt.z, dt, telegraphing ? 0.32 : 1); // fallback until the AI is built
    }

    // facing: aim at the player when engaging/winding up, else face travel
    const facePlayer = telegraphing || (ent.los && ent.distToPlayer < ent.weapon_.range);
    let target;
    if (facePlayer) {
      target = Math.atan2(px - ent.root.position.x, pz - ent.root.position.z);
    } else {
      const ms = Math.hypot(ent.vx, ent.vz);
      target = ms > 0.05 ? Math.atan2(ent.vx, ent.vz) : ent.yaw;
    }
    let dy = target - ent.yaw;
    while (dy > PI) dy -= TAU;
    while (dy < -PI) dy += TAU;
    ent.yaw += dy * Math.min(1, dt * 9);
    ent.root.rotation.y = ent.yaw;

    // pose: walk gait OR telegraph wind-up (weapon raised), + core glow + hit-flash punch
    poseTick(ent, dt, telegraphing);
    if (ent.human) { const ms = Math.hypot(ent.vx, ent.vz); ent.human.setMoving(ms > 0.4, ms); ent.human.fitTo(ent.root.scaling.x); }

    // expiry / siege → an account churns
    if (ent.age >= ent.maxLife) { churnAway(ent); return; }
    if (ent.root.position.z >= SIEGE_Z) { churnAway(ent); return; }
  }

  function poseTick(ent, dt, winding) {
    const p = ent.root.position;
    const moveSpeed = Math.hypot(ent.vx, ent.vz);
    const gaitFreq = 5.5 + moveSpeed * 0.9;
    ent.gait += dt * gaitFreq;

    if (winding) {
      // Telegraph pose: rear back, raise the weapon arm — a clear "incoming shot" read.
      const wp = 1 - clamp01(ent.telegraphT / (ent.telegraphMax || 1)); // 0→1 across the wind-up
      for (const pv of ent.pivots) {
        if (pv.kind === "arm") {
          // right arm aims forward/level; left arm braces a touch lower
          const target = pv.side > 0 ? -1.45 : -0.9;
          pv.node.rotation.x = lerp(pv.node.rotation.x, target, Math.min(1, dt * 13));
        } else {
          pv.node.rotation.x = lerp(pv.node.rotation.x, pv.side * 0.22, Math.min(1, dt * 12));
        }
      }
      ent.torso.rotation.x = lerp(ent.torso.rotation.x, -0.2, Math.min(1, dt * 12));
      p.y = lerp(p.y, 0.02 * ent.size, Math.min(1, dt * 8));
      const pulse = 0.6 + 0.4 * Math.sin(ent.age * 30);
      const glow = 1.4 + 1.4 * wp * pulse;
      _c3.copyFrom(ent.coreBase).scaleInPlace(glow);
      _c3.r = Math.min(1.4, _c3.r + 0.5 * wp); _c3.g = Math.min(1.2, _c3.g + 0.3 * wp); _c3.b = Math.min(1.2, _c3.b + 0.3 * wp);
      ent.coreMat.emissiveColor.copyFrom(_c3);
    } else {
      const swing = Math.sin(ent.gait);
      for (const pv of ent.pivots) {
        const phase = pv.side > 0 ? swing : -swing;
        const amp = pv.kind === "leg" ? 0.7 : 0.5;
        pv.node.rotation.x = (pv.kind === "leg" ? phase : -phase) * amp * clamp01(moveSpeed / (ent.speed || 1) + 0.2);
      }
      ent.torso.rotation.x = lerp(ent.torso.rotation.x, 0.06, Math.min(1, dt * 6));
      p.y = Math.abs(Math.sin(ent.gait)) * 0.045 * ent.size;
      const glow = 1 + 0.9 * ent.flash + 0.12 * Math.sin(ent.age * 3 + ent.phase);
      ent.coreMat.emissiveColor.copyFrom(ent.coreBase).scaleInPlace(glow);
    }

    let s = ent.size * (1 + 0.16 * ent.flash);
    if (winding) s = ent.size * (1 + 0.05 + 0.04 * (0.5 + 0.5 * Math.sin(ent.age * 30)));
    ent.root.scaling.setAll(s);
  }

  // ── director ─────────────────────────────────────────────────────────────────
  function currentSector(elapsedSec, phase) {
    if (phase === "overtime") return 4;
    const ts = elapsedSec < 22 ? 0 : elapsedSec < 45 ? 1 : elapsedSec < 68 ? 2 : 3;
    return Math.min(3, Math.max(ts, zoneSector));
  }

  function computeInterval(tension, phase) {
    let iv = 1.5 / (1 + tension * 1.15);
    iv /= game.mutator?.spawnMult || 1;
    if (phase === "renewal" && (game.timeLeft || 0) <= 20000) iv *= 0.6; // crescendo surge
    iv = Math.max(0.26, iv);
    return iv * frRange(0.85, 1.15);
  }

  function maxActiveFor(d01, tension, phase) {
    let cap = Math.floor(lerp(6, 16, d01));
    if (bossActive) cap += 4;
    if (phase === "overtime") cap += Math.floor(Math.min(tension, 5) * 2);
    return cap;
  }

  function liveCount() {
    let n = 0;
    for (const e of active) if (e.alive) n++;
    return n;
  }

  function spawnOne(sector, tension, d01) {
    let signalType;
    if (game.mutator?.championStorm && sector >= 1 && game.rng() < 0.25) {
      signalType = "champion_departure"; // Exec Escalation mutator
    } else {
      signalType = weightedPick(SECTOR_POOLS[sector]);
    }
    acquire(descFor(signalType, sector), tension, d01);
  }

  function spawnBoss(tension, d01) {
    bossActive = true;
    bossEnt = acquire(bossDesc(), tension, d01);
    bus?.emit?.("boss", { active: true });
    const escort = 2 + Math.floor(Math.min(tension, 3));
    for (let i = 0; i < escort; i++) {
      const st = game.rng() < 0.5 ? "critical_health_score" : "low_health_score";
      acquire(descFor(st, 3), tension, d01);
    }
  }

  function handleBossTiming(elapsedSec, phase, tension, d01) {
    if (bossActive) return;
    if (phase === "renewal") {
      if (!renewalBossDone && (game.timeLeft || 0) <= 20000 && elapsedSec > 6) {
        spawnBoss(tension, d01);
        renewalBossDone = true;
      }
    } else if (elapsedSec >= nextOvertimeBossAt) {
      spawnBoss(tension, d01);
      nextOvertimeBossAt = elapsedSec + 32;
    }
  }

  function clearAll() {
    for (let i = active.length - 1; i >= 0; i--) release(active[i]);
    ragdolls.length = 0;
    spawnAcc = 0;
    bossActive = false;
    bossEnt = null;
    fireBudget = 2.0;
    telegraphingCount = 0;
    calloutCd = 0;
    losCursor = 0;
    prevPx = null; prevPz = null;
    playerVel.x = 0; playerVel.z = 0;
  }

  // ── per-frame ────────────────────────────────────────────────────────────────
  function step(dt) {
    if (disposed) return;
    dt = Math.min(dt || 0, 0.05); // clamp huge frames (tab refocus)

    const status = game.status; // "running" | "lost"
    if (status !== prevStatus) {
      prevStatus = status;
      if (status === "lost") clearAll();
    }

    const phase = game.phase;
    if (phase !== prevPhase) {
      if (phase === "overtime" && prevPhase === "renewal") {
        bus?.emit?.("overtime");
        nextOvertimeBossAt = (game.elapsed || 0) / 1000 + 10;
      }
      prevPhase = phase;
    }

    if (readFlag(ctx.state?.paused, false)) return; // freeze everything incl. anims

    if (!occluders) buildOccluders();

    // Yuka steering: build once (needs the city's footprints), then integrate ALL live
    // vehicles for this frame. Runs on the scaled frame dt → enemies slow in bullet-time.
    // Targets were set last frame in stepEntity (1-frame latency, imperceptible).
    if (!enemyAI && (footprints.length || occluders)) {
      enemyAI = createEnemyAI({ bounds: BOUNDS, footprints });
    }
    if (enemyAI) enemyAI.update(dt);

    // Advance ragdoll physics on a fixed timestep (stable + cheap).
    // Havok path: parts are dynamic bodies stepped by main's pe._step — skip the integrator.
    if (ragdolls.length && !useHavok) {
      ragAcc += dt;
      let sub = 0;
      while (ragAcc >= RAG_H && sub < RAG_MAX_SUB) { ragdollSubstep(RAG_H); ragAcc -= RAG_H; sub++; }
      if (ragAcc > RAG_H * RAG_MAX_SUB) ragAcc = 0;
    } else {
      ragAcc = 0;
    }

    // Player position + smoothed velocity (for the shot dodge model + cover targeting).
    const px = playerX(), py = playerY(), pz = playerZ();
    lastPx = px; lastPy = py; lastPz = pz;
    if (prevPx != null && dt > 1e-4) {
      const ivx = (px - prevPx) / dt, ivz = (pz - prevPz) / dt;
      const a = Math.min(1, dt * 10);
      playerVel.x += (ivx - playerVel.x) * a;
      playerVel.z += (ivz - playerVel.z) * a;
    }
    prevPx = px; prevPz = pz;

    if (calloutCd > 0) calloutCd -= dt;

    // tension = f(elapsed, threat, combo) — elapsed (ms) keeps climbing in Overtime.
    const elapsedSec = (game.elapsed || 0) / 1000;
    const tension =
      (elapsedSec / 90) * 0.6 +
      ((game.threat || 0) / 100) * 0.5 +
      clamp01((game.combo || 0) / 14) * 0.25;
    tensionNow = tension;
    const d01 = clamp01(tension);

    // Fire-token governor regen (bounds incoming shots + raycasts; never starves to zero).
    fireBudget = Math.min(FIRE_BUDGET_MAX, fireBudget + (FIRE_REGEN_BASE + tension * FIRE_REGEN_TENSION) * dt);

    // Count current telegraphs + engagers (gates computed from last frame's state — no drift).
    telegraphingCount = 0;
    engageCount = 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (!e.alive) continue;
      if (e.telegraphT > 0) telegraphingCount++;
      if (e.state === ST.ENGAGE) engageCount++;
    }

    // Staggered LOS perception — only a few agents raycast per frame (round-robin).
    if (footprints.length || occluders) {
      const N = active.length;
      if (N > 0) {
        let checked = 0;
        for (let c = 0; c < N && checked < LOS_PER_FRAME; c++) {
          const ent = active[(losCursor + c) % N];
          if (ent.alive && ent.removing <= 0) { refreshLOS(ent, px, py, pz); checked++; }
        }
        losCursor = (losCursor + LOS_PER_FRAME) % N;
      }
    }

    // Advance removals + alive AI every (unpaused) frame.
    for (let i = active.length - 1; i >= 0; i--) {
      const ent = active[i];
      if (ent.removeMode === "ragdoll") animateRagdoll(ent, dt);
      else if (ent.removing > 0) animateFade(ent, dt);
      else stepEntity(ent, dt, px, py, pz);
    }

    updateShotFx(dt);

    if (status !== "running" || !readFlag(ctx.state?.running, true)) return;

    const sector = currentSector(elapsedSec, phase);
    handleBossTiming(elapsedSec, phase, tension, d01);

    if (elapsedSec > 0.6) {
      spawnAcc += dt;
      if (spawnAcc >= spawnInterval) {
        spawnAcc = 0;
        spawnInterval = computeInterval(tension, phase);
        if (liveCount() < maxActiveFor(d01, tension, phase)) spawnOne(sector, tension, d01);
      }
    }
  }

  // ── bus wiring + lifecycle ───────────────────────────────────────────────────
  const handlers = [];
  function on(name, fn) {
    if (!bus?.on) return;
    bus.on(name, fn);
    handlers.push([name, fn]);
  }

  on("start", () => {
    clearAll();
    prevStatus = game.status;
    prevPhase = game.phase;
    zoneSector = 0;
    renewalBossDone = false;
    nextOvertimeBossAt = Infinity;
    spawnAcc = 0;
    spawnInterval = 0.9;
    // Reseed the brain/cosmetic stream so a daily seed reproduces visuals too (only kill
    // ORDER, which is player-driven, varies the run-to-run feel).
    fxRng = mulberry32((seedBase ^ 0x1b56c4f9) >>> 0 || 1);
    bus?.emit?.("mutator", { name: game.mutator?.name || "" });
  });

  on("zone", (e) => {
    const k = String(e?.name || "").toLowerCase();
    if (k in ZONE_INDEX) zoneSector = Math.max(zoneSector, ZONE_INDEX[k]);
  });

  ctx.onFrame?.(step);

  return {
    update(dt) { step(dt); },
    // Live hit-capsules (copy — never hand out the mutable internal array).
    list() {
      const out = [];
      for (const e of active) if (e.alive && e.removing <= 0) out.push(e.hit);
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (bus?.off) for (const [n, fn] of handlers) { try { bus.off(n, fn); } catch (_) {} }
      handlers.length = 0;

      for (const ent of rigs) {
        try {
          ent.hit.metadata = null;
          // aim-laser is UNPARENTED → dispose it before the root tree goes.
          try { ent.aimLine.dispose(); } catch (_) {}
          for (const part of ent.parts) { try { part.mesh.parent = ent.root; } catch (_) {} }
          ent.root.dispose(false, false); // disposes the whole hierarchy; shared mats kept
        } catch (_) {}
      }
      rigs.length = 0;
      active.length = 0;
      ragdolls.length = 0;
      for (const key in pools) pools[key].length = 0;

      for (const t of shotTracers) { try { t.mesh.dispose(); } catch (_) {} }
      for (const f of shotFlashes) { try { f.mesh.dispose(); } catch (_) {} }
      shotTracers.length = 0;
      shotFlashes.length = 0;

      for (const m of mats) { try { m.dispose(); } catch (_) {} }
      for (const t of texes) { try { t.dispose(); } catch (_) {} }
      mats.length = 0;
      texes.length = 0;
      badgeCache.clear();
      if (occluders) occluders.clear();
      occluders = null;
      footprints = [];
    },
  };
}

// FNV-1a (matches brand.js) — deterministic seed fallback from the daily-seed string.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function numOr(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
