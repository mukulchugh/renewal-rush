// Pure, engine-agnostic game state — the Quivly "renewal" meta loop.
// No Babylon imports: runnable under `node --test` / `bun test` for headless verification.
//
// This is the numbers brain for Renewal Rush. It implements DESIGN.md §1 (two-act
// session) and §2 (economy/incentive math) exactly, themed per QUIVLY-GROUNDING.md:
// you are a CSM commanding the AI workforce — deploy agents onto churn SIGNALS,
// keep portfolio Health up, and bank ARR before renewal day (90s), then survive
// Overtime for the score chase.
//
// Contract notes (ARCHITECTURE.md):
//   - Engine modules read/mutate this instance: enemies calls deploySignal /
//     signalEscaped / hitHealthy and reads game.timeLeft / .elapsed / .threat /
//     .combo / .status / .phase; hud reads snapshot() + rank(); main drives tick().
//   - This file is PURE: no Date.now / Math.random. Determinism comes from an
//     injected seed + a mulberry32 RNG (game.rng) so daily seeds reproduce.
//   - deploySignal keeps the { baseArr, chips } signature. `baseArr` is the
//     already-risk-scaled bucket value (enemies passes BUCKET_ARR[bucket], doubled
//     for champion_departure, ×mutator.arrMult). `chips` is the source count.

export const RENEWAL_MS = 90_000; // Act 1 — renewal day sprint
export const WIN_HEALTH = 40; // survive renewal day with health >= this to win
export const COMBO_TIERS = [3, 6, 10]; // combo multiplier steps
export const SIGNALS = ["CRM", "Gong", "Stripe", "Zendesk", "Slack", "Market"];

export const START_HEALTH = 100;
export const MAX_HEALTH = 100;

// Per-bucket base ARR (riskier saves pay more). DESIGN §2.
// enemies passes baseArr = BUCKET_ARR[bucket]; Healthy accounts are never a target.
export const BUCKET_ARR = { critical: 800, high: 500, medium: 280 };

// Health lost when a signal escapes, indexed by severity 0..3 (medium→critical).
// DESIGN §2: escape costs 6..14 by bucket. champion_departure doubles this.
const ESCAPE_HEALTH = [6, 6, 10, 14];

// ── Combo / Full-Stack / rank math (pure, exported for reuse + tests) ───────────

// ARR multiplier by combo (1x..5x). DESIGN §2 keeps the runner's tiers.
export function multiplierFor(combo) {
  if (combo >= COMBO_TIERS[2]) return 5;
  if (combo >= COMBO_TIERS[1]) return 3;
  if (combo >= COMBO_TIERS[0]) return 2;
  return 1;
}
// Alias under the DESIGN name; same tiers.
export function comboMult(combo) {
  return multiplierFor(combo);
}

// Full-Stack multiplier by source count — THE strategic core (connecting the stack
// pays; Quivly's moat). DESIGN §2: 1 + 0.5*(sources-1) → 1×, 1.5×, 2.0× …
export function fullStackMult(sources) {
  const n = Math.max(1, sources | 0);
  return 1 + 0.5 * (n - 1);
}

// Named ranks by ARR (DESIGN §4). Thresholds are exclusive upper bounds; the last
// tier is open-ended. Mirrors brand.js RANKS so the HUD and result card agree.
export const RANK_TABLE = [
  { tier: 1, name: "Renewal Rookie", max: 5_000 },
  { tier: 2, name: "Account Defender", max: 15_000 },
  { tier: 3, name: "CSM Speedrunner", max: 40_000 },
  { tier: 4, name: "VP Retention", max: 80_000 },
  { tier: 5, name: "Chief Renewal Officer", max: Infinity },
];

// Rank from ARR saved. (Second arg accepted + ignored for back-compat with old
// calcRank(arr, health) callers; DESIGN §4 makes rank a pure function of ARR.)
export function calcRank(arr) {
  const v = Math.max(0, +arr || 0);
  for (const r of RANK_TABLE) if (v < r.max) return r.name;
  return RANK_TABLE[RANK_TABLE.length - 1].name;
}

// Remaining ARR ($) to the next rank tier. 0 once you're Chief Renewal Officer.
export function nextRankArr(arr) {
  const v = Math.max(0, +arr || 0);
  for (const r of RANK_TABLE) {
    if (v < r.max) return r.max === Infinity ? 0 : Math.max(0, r.max - v);
  }
  return 0;
}

// ── Seeded RNG + run mutators (DESIGN §3 / §4 daily seed) ───────────────────────

// mulberry32: tiny, fast, well-distributed seeded PRNG → [0,1). Deterministic, so a
// daily seed reproduces the same mutator + spawn pattern ("beat my run").
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic seed for no-seed (FTUE / Endless) runs so behavior is reproducible
// without Date.now/Math.random. Golden-ratio constant.
const DEFAULT_SEED = 0x9e3779b9;

// One mutator per run (DESIGN §3). These are DATA the engine reads: enemies scales
// spawns/hp/speed and folds arrMult into baseArr; combat reads pulseMult.
// NOTE: arrMult is intentionally NOT applied inside deploySignal — enemies bakes it
// into baseArr — so the { baseArr, chips } payout stays a clean, testable product.
export const MUTATORS = Object.freeze([
  Object.freeze({
    id: "standard",
    name: "Standard Renewal",
    desc: "A clean quarter. Connect the stack and defend the book.",
    spawnMult: 1.0, arrMult: 1.0, pulseMult: 1.0, hpMult: 1.0, speedMult: 1.0,
    championStorm: false,
  }),
  Object.freeze({
    id: "black_friday",
    name: "Black Friday Surge",
    desc: "Signals flood in 2× — but every save pays 1.3×.",
    spawnMult: 2.0, arrMult: 1.3, pulseMult: 1.0, hpMult: 1.0, speedMult: 1.05,
    championStorm: false,
  }),
  Object.freeze({
    id: "budget_freeze",
    name: "Budget Freeze",
    desc: "Pulse cadence slows — but saves pay more.",
    spawnMult: 0.9, arrMult: 1.25, pulseMult: 0.7, hpMult: 1.0, speedMult: 1.0,
    championStorm: false,
  }),
  Object.freeze({
    id: "exec_escalation",
    name: "Exec Escalation",
    desc: "Champion-departure storm — must-catch targets everywhere.",
    spawnMult: 1.15, arrMult: 1.0, pulseMult: 1.0, hpMult: 1.0, speedMult: 1.1,
    championStorm: true,
  }),
  Object.freeze({
    id: "quiet_quarter",
    name: "Quiet Quarter",
    desc: "Fewer signals — but each one is far tankier.",
    spawnMult: 0.6, arrMult: 1.1, pulseMult: 1.0, hpMult: 1.6, speedMult: 0.95,
    championStorm: false,
  }),
]);

// Deterministically choose a mutator from a seed. No seed → neutral "standard"
// (approachable first-time run). A real seed → one of the 4 flavor mutators.
export function mutatorFor(seed) {
  if (seed == null) return MUTATORS[0];
  const r = mulberry32((seed >>> 0) ^ 0x85ebca6b); // de-correlate from spawn RNG
  const idx = 1 + Math.floor(r() * (MUTATORS.length - 1));
  return MUTATORS[Math.min(idx, MUTATORS.length - 1)];
}

// ── The loop ────────────────────────────────────────────────────────────────────

export class Game {
  // seed: optional number. `new Game()` stays valid (deterministic default seed,
  // neutral mutator). `new Game(dailySeed)` reproduces a daily run.
  constructor(seed) {
    this._seed = seed === undefined ? null : seed;
    this.reset();
  }

  // reset() with no arg REUSES the stored seed (main.js calls bare reset() on every
  // "start", so daily-seed determinism must survive restarts). reset(seed) rerolls.
  reset(seed) {
    if (seed !== undefined) this._seed = seed;
    this.seed = this._seed; // null for default/Endless runs

    // Deterministic spawn stream for enemies (game.rng). Mutator picked separately.
    this.rng = mulberry32(((this._seed == null ? DEFAULT_SEED : this._seed) >>> 0) || 1);
    this.mutator = mutatorFor(this._seed);

    // Act 1 clock + survival state.
    this.timeLeft = RENEWAL_MS; // counts down in renewal; pinned at 0 in overtime
    this.elapsed = 0; // total ms elapsed — keeps climbing through overtime
    this.health = START_HEALTH; // portfolio health (0..100)
    this.threat = 0; // churn threat (0..100) — feeds the difficulty director
    this.arr = 0; // ARR saved = score

    this.combo = 0;
    this.maxCombo = 0;
    this.deploys = 0; // signals neutralized
    this.escaped = 0; // signals missed
    this.fullStackCatches = 0; // multi-source saves (for the result card)

    // status: "running" | "lost". The Act-1 win is NOT a terminal status — it flips
    // wonRenewal + phase and the run continues into Overtime. The run only ENDS when
    // health hits 0 ("lost"). (Consumers that gate on status==="won" must switch to
    // wonRenewal / phase==="overtime" — see risks in the overhaul notes.)
    this.status = "running";
    this.phase = "renewal"; // "renewal" (Act 1) → "overtime" (Act 2)
    this.wonRenewal = false; // banked the shareable renewal win?
    return this;
  }

  get multiplier() {
    return multiplierFor(this.combo);
  }

  // Convenience deterministic helpers for the spawner (optional sugar over game.rng).
  randRange(lo, hi) {
    return lo + (hi - lo) * this.rng();
  }
  randInt(lo, hi) {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  // Advance the clock. DESIGN §1 two acts:
  //  - Act 1 (renewal): countdown; at 0, health>=WIN_HEALTH → bank the win + enter
  //    Overtime (status STAYS "running"); else → "lost".
  //  - Act 2 (overtime): timer pinned at 0, elapsed climbs; only health 0 ends it.
  tick(dtMs) {
    if (this.status !== "running") return this.status;
    const dt = Math.max(0, dtMs || 0);
    this.elapsed += dt;
    if (this.phase === "renewal") {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft <= 0) {
        if (this.health >= WIN_HEALTH) {
          this.wonRenewal = true;
          this.phase = "overtime"; // status stays "running" → survival continues
        } else {
          this.status = "lost";
        }
      }
    }
    return this.status;
  }

  // Neutralize a churn signal (a kill). DESIGN §2 payout:
  //   arr = baseArr * fullStackMult(chips) * comboMult(combo)
  // baseArr is the already-risk-scaled bucket value enemies passes (BUCKET_ARR[bucket],
  // ×2 for champion_departure, ×mutator.arrMult). chips = source count (Full Stack).
  // Back-compat anchor: deploySignal({baseArr:200,chips:1}) at combo 1 returns 200.
  deploySignal({ baseArr = 220, chips = 1 } = {}) {
    if (this.status !== "running") return 0;
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);

    const sources = Math.max(1, chips | 0);
    const gain = Math.round(baseArr * fullStackMult(sources) * comboMult(this.combo));
    this.arr += gain;
    this.deploys += 1;
    if (sources >= 3) this.fullStackCatches += 1;

    // Catches heal small (+1..+3, more for Full Stack) and decay threat slowly.
    this._modHealth(Math.min(3, sources));
    this._modThreat(-(2 + Math.min(3, sources)));
    return gain;
  }

  // A churn signal slipped past — untriaged risk. Breaks combo, drains health, spikes
  // threat. severity 0..3 = medium..critical. champion_departure (opts.champion)
  // doubles the health + threat penalty (must-catch). DESIGN §2.
  signalEscaped(severity = 1, opts = {}) {
    if (this.status !== "running") return;
    const champion = !!(opts && opts.champion);
    const sev = Math.max(0, Math.min(3, severity | 0));
    const mult = champion ? 2 : 1;

    this.escaped += 1;
    this.combo = 0;
    this._modHealth(-ESCAPE_HEALTH[sev] * mult);
    this._modThreat((8 + sev * 2) * mult);
  }

  // Wasted an agent on a healthy account (false positive). DESIGN §2: combo→0, −8.
  hitHealthy() {
    if (this.status !== "running") return;
    this.combo = 0;
    this._modHealth(-8);
  }

  // External contact damage (seeking churn/boss). main routes bus "hurt" here,
  // gated on dash i-frames. _modHealth flips status->"lost" at 0.
  takeDamage(amount = 0) {
    if (this.status !== "running") return;
    this._modHealth(-Math.abs(amount));
  }

  _modHealth(d) {
    this.health = clamp(this.health + d, 0, MAX_HEALTH);
    if (this.health <= 0) this.status = "lost";
  }

  _modThreat(d) {
    this.threat = clamp(this.threat + d, 0, 100);
  }

  rank() {
    return calcRank(this.arr);
  }

  snapshot() {
    return {
      timeLeft: this.timeLeft,
      elapsed: this.elapsed,
      health: this.health,
      threat: this.threat,
      arr: this.arr,
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: this.multiplier,
      deploys: this.deploys,
      escaped: this.escaped,
      fullStackCatches: this.fullStackCatches,
      status: this.status,
      phase: this.phase,
      wonRenewal: this.wonRenewal,
      rank: this.rank(),
      nextRankArr: nextRankArr(this.arr),
      mutator: this.mutator?.name || "",
      mutatorId: this.mutator?.id || "",
    };
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}