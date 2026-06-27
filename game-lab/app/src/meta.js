// meta.js — Renewal Rush STICKINESS layer (DESIGN.md §4).
//
// This is the replay/share/roguelite spine that turns a 90s marketing hook into a
// "one more run" loop. It is deliberately ENGINE-AGNOSTIC: no Babylon, no meshes —
// only DOM, localStorage, the shared bus, ctx.state, and ctx.game. That keeps it
// node-friendly and cheap, and lets it degrade gracefully inside locked-down embeds.
//
// Responsibilities (all wired through the ARCHITECTURE.md contract):
//   1. BEST + mini-leaderboard  — top 5 by ARR (rank/date/mode), localStorage, try/catch
//      guarded (embeds may forbid storage). getBest()/getLeaderboard() for HUD + title.
//   2. RESULT CARD on win/lose  — builds the run summary from ctx.game and delegates to
//      ctx.brand.showResult(summary) when present; otherwise renders a minimal on-brand
//      fallback with navigator.share → clipboard → PNG download + the quivly.ai CTA.
//   3. DAILY SEED               — resolves a deterministic seed from ctx (dailySeed/seed)
//      so "run of the day" repeats (mutator + draft offers + spawn pattern). Daily vs
//      Endless. Never reads Date.now for the seed — the date comes from ctx.
//   4. UPGRADE DRAFT (roguelite)— at every real sector boundary (bus "zone", skipping the
//      Connect spawn-in) it pauses, offers 1-of-3 Quivly-themed upgrades, awaits the pick
//      (internal picker OR external bus "draftPick"), applies it data-only into
//      ctx.upgrades, emits "upgrade" {effect}, and unpauses. Other modules READ ctx.upgrades
//      — meta never reaches into their internals.
//   5. LAST STAND              — at health ≤ 20 (once per run) it drops a ~2s slow-mo
//      "Focus" via ctx.state.timeScale and grants a comeback heal if 3 catches land in the
//      window, then restores timeScale.
//
// Contract notes for the integrator (main.js — NOT edited here):
//   • Init meta LAST (after fx AND brand). Two reasons: (a) ctx.brand must exist for the
//     result card; (b) the Last Stand re-cap of state.timeScale must run AFTER fx's
//     hitStop logic each frame, and onFrame callbacks fire in insertion order.
//       e.g.  ctx.meta = createMeta(ctx);   // after createBrand(ctx)
//   • Pass a daily seed in:  ctx.dailySeed = "<YYYY-MM-DD>"  (or ctx.seed). Computed from a
//     date the integrator already has — meta will not call Date.now for it.
//   • Other modules should READ ctx.upgrades (meta initialises + owns it):
//       enemies.js → baseArr *= upgrades.arrMult (Data Lake);  seeker speed *= upgrades.seekerSlowMult
//                    (Sentiment Engine);  telegraph next spawn when upgrades.forecast (Forecast).
//       combat.js  → fire interval /= upgrades.pulseRateMult (Webhook);  AoE radius *= upgrades.aoeRadiusMult
//                    (Skill Template).
//     "Auto-Renew" (heal on Full Stack) is applied by meta itself (it already tracks catches).
//   • Optional: game.js could expose snapshot().fullStack — meta prefers it if present and
//     otherwise derives Full-Stack catches from the "kill" payload's kind.

// ── Tunables (DESIGN.md §4) ──────────────────────────────────────────────────────
const LB_KEY = "rr.leaderboard.v1"; // localStorage key (versioned)
const LB_MAX = 5; // mini-leaderboard depth
const MODE_KEY = "rr.mode.v1"; // persisted Daily/Endless preference

const LAST_STAND_HEALTH = 20; // Focus triggers at/under this health, once per run
const FOCUS_SCALE = 0.5; // slow-mo time scale during Focus
const FOCUS_DURATION = 2.0; // wall-clock seconds the Focus window lasts
const FOCUS_HEAL_KILLS = 3; // catches needed inside the window for the comeback
const COMEBACK_HEAL = 25; // health restored if the clutch lands

const AUTORENEW_HEAL = 4; // small heal per Full-Stack catch when Auto-Renew is owned
const FULLSTACK_CHIPS = 3; // a "Full Stack" save = 3+ stacked sources (Quivly's moat)

// kind → source-chip count (kill payload carries kind, not chips). Mirrors enemies.js KIND.
const KIND_CHIPS = { signal: 1, elite: 2, shielded: 3, churn: 2, boss: 5, healthy: 0 };

// Ranks by ARR (DESIGN.md §4). Inlined so meta stays Babylon-free; ctx.brand.rankFor is
// preferred at runtime when present so naming never drifts from brand.js.
const RANKS = [
  { max: 5_000, name: "Renewal Rookie" },
  { max: 15_000, name: "Account Defender" },
  { max: 40_000, name: "CSM Speedrunner" },
  { max: 80_000, name: "VP Retention" },
  { max: Infinity, name: "Chief Renewal Officer" },
];

// Upgrade pool (DESIGN.md §4 / QUIVLY-GROUNDING — note: NO "Playbook", it's "Skill").
// apply(up) mutates ctx.upgrades only; consumers read those fields. Each effect stacks.
const UPGRADES = [
  {
    id: "webhook",
    name: "Webhook",
    glyph: "⚡",
    tag: "+25% pulse rate",
    desc: "Real-time triggers. Your agent deploys faster the instant a signal lands.",
    apply: (up) => { up.pulseRateMult = round2(up.pulseRateMult * 1.25); },
  },
  {
    id: "data_lake",
    name: "Data Lake",
    glyph: "🗄️",
    tag: "+15% ARR saved",
    desc: "Every source in one warehouse. Richer context, bigger saves on every deploy.",
    apply: (up) => { up.arrMult = round2(up.arrMult * 1.15); },
  },
  {
    id: "auto_renew",
    name: "Auto-Renew",
    glyph: "♻️",
    tag: "Heal on Full Stack",
    desc: "Multi-source saves renew the portfolio. Catch a Full-Stack card, regain health.",
    apply: (up) => { up.healOnFullStack = true; },
  },
  {
    id: "sentiment_engine",
    name: "Sentiment Engine",
    glyph: "🛰️",
    tag: "Slow seekers −30%",
    desc: "Read the room early. Aggressive churn signals close in slower around you.",
    apply: (up) => { up.seekerSlowMult = round2(up.seekerSlowMult * 0.7); },
  },
  {
    id: "forecast",
    name: "Forecast",
    glyph: "🔭",
    tag: "See next spawn",
    desc: "Predictive health. The next wave is telegraphed before it surfaces.",
    apply: (up) => { up.forecast = true; },
  },
  {
    id: "skill_template",
    name: "Skill Template",
    glyph: "🧩",
    tag: "+40% AoE radius",
    desc: "A reusable recommended play. Your deploy pulse resolves a wider blast of signals.",
    apply: (up) => { up.aoeRadiusMult = round2(up.aoeRadiusMult * 1.4); },
  },
];

// ── Small dependency-free helpers ─────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

function num(...vals) {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function commaARR(v) {
  return "$" + Math.round(num(v)).toLocaleString("en-US");
}

// Deterministic 32-bit string hash (FNV-1a-ish) → seed material.
function hashStr(s) {
  s = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — tiny, good-enough PRNG for deterministic daily draft offers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rankName(arr, ctx) {
  // Prefer brand's authoritative ranker so names never drift.
  try {
    const n = ctx?.brand?.rankFor?.(num(arr))?.name;
    if (n) return n;
  } catch (_) { /* fall through */ }
  const a = num(arr);
  for (const r of RANKS) if (a < r.max) return r.name;
  return RANKS[RANKS.length - 1].name;
}

// ── Factory ───────────────────────────────────────────────────────────────────────
export function createMeta(ctx = {}) {
  const bus = ctx.bus;
  const game = ctx.game;
  const engine = ctx.engine;
  const onFrame = typeof ctx.onFrame === "function" ? ctx.onFrame : null;
  const hasDOM = typeof document !== "undefined";

  let disposed = false;

  // Shared upgrade state — DATA ONLY. Other modules read these; meta is the sole writer.
  const upgrades = {
    arrMult: 1, // Data Lake          (enemies scales baseArr)
    pulseRateMult: 1, // Webhook            (combat scales fire rate)
    aoeRadiusMult: 1, // Skill Template     (combat scales AoE radius)
    seekerSlowMult: 1, // Sentiment Engine   (enemies scales seeker speed)
    healOnFullStack: false, // Auto-Renew  (meta applies the heal itself)
    forecast: false, // Forecast            (enemies telegraphs next spawn)
    taken: [], // ids picked this run, in order
  };
  ctx.upgrades = upgrades;

  function resetUpgrades() {
    upgrades.arrMult = 1;
    upgrades.pulseRateMult = 1;
    upgrades.aoeRadiusMult = 1;
    upgrades.seekerSlowMult = 1;
    upgrades.healOnFullStack = false;
    upgrades.forecast = false;
    upgrades.taken.length = 0;
  }

  // ── Daily seed / mode ────────────────────────────────────────────────────────
  // Read the seed from ctx ONLY (never Date.now). If ctx supplies one → Daily run;
  // otherwise → Endless with a fresh random seed. Mode preference is persisted but the
  // seed source still decides what's actually possible (Daily needs a ctx seed).
  const providedSeed = ctx.dailySeed != null ? ctx.dailySeed : ctx.seed;
  let mode = providedSeed != null ? "daily" : "endless";
  // Honour a stored preference where the seed allows it.
  try {
    const pref = hasStorage() ? localStorage.getItem(MODE_KEY) : null;
    if (pref === "endless") mode = "endless";
    else if (pref === "daily" && providedSeed != null) mode = "daily";
  } catch (_) { /* ignore */ }

  let dailySeed = providedSeed != null ? hashStr(providedSeed) : 0;
  let endlessSeed = (Math.random() * 0xffffffff) >>> 0; // Math.random is fine — it's not Date.now
  const runSeed = () => (mode === "daily" && providedSeed != null ? dailySeed : endlessSeed);
  // Publish the resolved seed so enemies.js can drive a deterministic mutator/spawn pattern.
  ctx.seed = runSeed();

  function setMode(next) {
    if (next !== "daily" && next !== "endless") return mode;
    if (next === "daily" && providedSeed == null) return mode; // no seed → can't go daily
    mode = next;
    if (mode === "endless") endlessSeed = (Math.random() * 0xffffffff) >>> 0;
    ctx.seed = runSeed();
    try { if (hasStorage()) localStorage.setItem(MODE_KEY, mode); } catch (_) { /* ignore */ }
    return mode;
  }

  // ── Per-run state ────────────────────────────────────────────────────────────
  let fullStackCount = 0; // Full-Stack catches this run (for the summary + Auto-Renew)
  let draftedSectors = new Set(); // sector indices already drafted (no re-draft on backtrack)
  let draftSerial = 0; // increments per draft → deterministic-but-distinct daily offers
  let currentDraft = null; // { token, options:[...] } while a picker is open
  let lastStandUsed = false; // Focus is once-per-run
  let focusActive = false;
  let focusTimer = 0; // wall-clock seconds remaining in the Focus window
  let focusKills = 0; // catches landed inside the window
  let lastSummary = null;

  function resetRun() {
    fullStackCount = 0;
    draftedSectors = new Set();
    draftSerial = 0;
    lastStandUsed = false;
    focusActive = false;
    focusTimer = 0;
    focusKills = 0;
    closeDraftUI();
    currentDraft = null;
    resetUpgrades();
    // Re-resolve the run seed (Endless gets a fresh one each run; Daily stays stable).
    if (mode === "endless") endlessSeed = (Math.random() * 0xffffffff) >>> 0;
    ctx.seed = runSeed();
    if (ctx.state) {
      ctx.state.paused = false;
      ctx.state.timeScale = 1;
    }
  }

  // ── Run summary (built from ctx.game directly — snapshot omits maxCombo/escaped) ──
  function buildSummary(won) {
    const g = game || {};
    const snap = typeof g.snapshot === "function" ? g.snapshot() : {};
    const arr = num(g.arr, snap.arr, 0);
    return {
      won: !!won,
      arr,
      rank: rankName(arr, ctx),
      health: num(g.health, snap.health, 0),
      deploys: num(g.deploys, snap.deploys, 0),
      maxCombo: num(g.maxCombo, 0),
      escaped: num(g.escaped, 0),
      timeLeftMs: num(g.timeLeft, snap.timeLeft, 0),
      // Prefer an authoritative game counter if it ever exists; else our derived tally.
      fullStack: num(snap.fullStack, fullStackCount, 0),
      mode,
      seed: runSeed(),
    };
  }

  // ── Leaderboard (localStorage, fully guarded) ────────────────────────────────
  function hasStorage() {
    try {
      return typeof localStorage !== "undefined" && localStorage != null;
    } catch (_) {
      return false; // some embeds throw on mere access
    }
  }

  function loadBoard() {
    if (!hasStorage()) return [];
    try {
      const raw = localStorage.getItem(LB_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveBoard(board) {
    if (!hasStorage()) return;
    try {
      localStorage.setItem(LB_KEY, JSON.stringify(board.slice(0, LB_MAX)));
    } catch (_) { /* quota / disabled — non-fatal */ }
  }

  function dateLabel() {
    // Prefer a date the integrator already has; only fall back to a local stamp.
    if (typeof ctx.dateLabel === "string") return ctx.dateLabel;
    try {
      const t = typeof ctx.now === "number" ? new Date(ctx.now) : new Date();
      return t.toISOString().slice(0, 10);
    } catch (_) {
      return "";
    }
  }

  function recordRun(summary) {
    const board = loadBoard();
    board.push({
      arr: Math.round(num(summary.arr)),
      rank: summary.rank,
      deploys: num(summary.deploys),
      fullStack: num(summary.fullStack),
      health: Math.round(num(summary.health)),
      won: !!summary.won,
      mode: summary.mode || mode,
      date: dateLabel(),
    });
    board.sort((a, b) => num(b.arr) - num(a.arr));
    const trimmed = board.slice(0, LB_MAX);
    saveBoard(trimmed);
    return trimmed;
  }

  function getLeaderboard() {
    return loadBoard().slice(0, LB_MAX);
  }

  function getBest() {
    const board = loadBoard();
    return board.length ? board[0] : null;
  }

  // ── Result card / share ──────────────────────────────────────────────────────
  function shareText(s) {
    return s.won
      ? `I saved ${commaARR(s.arr)} ARR before renewal day in Renewal Rush — rank ${s.rank}. Beat my run.`
      : `Renewal day caught me in Renewal Rush — ${commaARR(s.arr)} ARR saved. Think you can keep the accounts?`;
  }

  // Minimal on-brand share card used ONLY when ctx.brand is absent (brand.js renders the
  // real one). Kept compact — we do not duplicate brand's full renderer.
  function renderShareCanvas(s) {
    if (!hasDOM) return null;
    const W = 1200;
    const H = 630;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const g = cv.getContext("2d");
    if (!g) return null;
    const accent = s.won ? "#6366F1" : "#F87171";
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#0b0b14");
    grad.addColorStop(1, "#13132a");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.font = "800 30px Inter, system-ui, sans-serif";
    g.fillText("QUIVLY · RENEWAL RUSH", 64, 88);
    g.fillStyle = "#F1F2F7";
    g.font = "800 86px Inter, system-ui, sans-serif";
    g.fillText(s.won ? "RENEWAL SAVED" : "RENEWAL LOST", 64, 210);
    g.fillStyle = "#FCD34D";
    g.font = "800 120px Inter, system-ui, sans-serif";
    g.fillText(commaARR(s.arr), 64, 360);
    g.fillStyle = "#9AA0B4";
    g.font = "600 34px Inter, system-ui, sans-serif";
    g.fillText("ARR SAVED", 64, 404);
    g.fillStyle = "#a5b4fc";
    g.font = "700 40px Inter, system-ui, sans-serif";
    g.fillText(`Rank: ${s.rank}`, 64, 482);
    g.fillStyle = "#9AA0B4";
    g.font = "600 30px Inter, system-ui, sans-serif";
    g.fillText(`${num(s.deploys)} deploys · ${num(s.fullStack)} Full-Stack catches`, 64, 528);
    g.fillStyle = "#F1F2F7";
    g.font = "700 30px Inter, system-ui, sans-serif";
    g.fillText("Your post-sales team, without the headcount — book a demo → quivly.ai", 64, H - 48);
    return cv;
  }

  function downloadCanvas(cv, name) {
    try {
      const a = document.createElement("a");
      a.download = name;
      a.href = cv.toDataURL("image/png");
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  // Public: share the latest (or given) summary. navigator.share → clipboard → PNG download.
  async function share(summary) {
    const s = summary || lastSummary || buildSummary(true);
    const text = shareText(s);
    const url = "https://app.quivly.ai";
    try {
      const cv = renderShareCanvas(s);
      if (cv && typeof navigator !== "undefined" && navigator.canShare) {
        const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
        if (blob) {
          const file = new File([blob], "renewal-rush.png", { type: "image/png" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: "Renewal Rush", text, url });
            return "share-image";
          }
        }
      }
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "Renewal Rush", text, url });
        return "share-text";
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${text} ${url}`);
        return "clipboard";
      }
      if (cv) return downloadCanvas(cv, "renewal-rush.png") ? "download" : false;
    } catch (_) { /* user cancelled or blocked — non-fatal */ }
    return false;
  }

  // Lightweight fallback result overlay (only when ctx.brand is missing).
  let fbOverlay = null;
  function showFallbackResult(s) {
    if (!hasDOM) return;
    ensureStyles();
    closeFallbackResult();
    const ov = document.createElement("div");
    ov.className = "rrm-overlay";
    const accent = s.won ? "#6366F1" : "#F87171";
    ov.innerHTML = `
      <div class="rrm-card" style="--rrm-accent:${accent}">
        <div class="rrm-kicker">QUIVLY · RENEWAL RUSH</div>
        <div class="rrm-title">${s.won ? "RENEWAL SAVED" : "RENEWAL LOST"}</div>
        <div class="rrm-arr">${commaARR(s.arr)}</div>
        <div class="rrm-sub">ARR saved · Rank ${escapeHtml(s.rank)} · ${num(s.deploys)} deploys</div>
        <div class="rrm-actions">
          <button class="rrm-btn rrm-primary" data-act="share">Share result</button>
          <a class="rrm-btn" href="https://app.quivly.ai" target="_blank" rel="noopener noreferrer">Book a demo →</a>
          <button class="rrm-btn" data-act="again">Play again</button>
        </div>
        <div class="rrm-foot">Quivly does this for real, autonomously — across your whole stack.</div>
      </div>`;
    ov.addEventListener("click", (e) => {
      const act = e.target?.getAttribute?.("data-act");
      if (act === "share") share(s);
      else if (act === "again") { closeFallbackResult(); bus?.emit?.("start"); }
      else if (e.target === ov) closeFallbackResult();
    });
    document.body.appendChild(ov);
    fbOverlay = ov;
    try { document.exitPointerLock?.(); } catch (_) { /* ignore */ }
    requestAnimationFrame(() => ov.classList.add("rrm-show"));
  }
  function closeFallbackResult() {
    if (fbOverlay) { try { fbOverlay.remove(); } catch (_) { /* ignore */ } fbOverlay = null; }
  }

  // ── Upgrade draft ────────────────────────────────────────────────────────────
  function offerOptions() {
    const pool = UPGRADES.filter((u) => !upgrades.taken.includes(u.id));
    if (pool.length === 0) return [];
    // Daily → deterministic shuffle from the seed + draft index; Endless → Math.random.
    const rng = mode === "daily" && providedSeed != null
      ? mulberry32((runSeed() ^ Math.imul(draftSerial + 1, 0x9e3779b1)) >>> 0)
      : Math.random;
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor((typeof rng === "function" ? rng() : Math.random()) * (i + 1));
      const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    return shuffled.slice(0, Math.min(3, shuffled.length));
  }

  function openDraft(sectorIndex, sectorName) {
    if (disposed || currentDraft) return;
    const options = offerOptions();
    if (options.length === 0) return; // pool exhausted — nothing to offer, skip pause
    draftSerial += 1;
    const token = draftSerial;
    currentDraft = {
      token,
      options,
      sector: sectorName || "",
      index: sectorIndex,
    };
    if (ctx.state) ctx.state.paused = true;
    // Broadcast so an external UI (HUD) can render too; the pick routes back through us.
    bus?.emit?.("draft", {
      token,
      sector: sectorName || "",
      index: sectorIndex,
      options: options.map((o) => ({ id: o.id, name: o.name, tag: o.tag, desc: o.desc, glyph: o.glyph })),
    });
    showDraftUI(currentDraft);
  }

  // Single idempotent apply path for BOTH the internal picker and external "draftPick".
  function applyPick(idOrPayload) {
    if (!currentDraft) return false;
    let id = idOrPayload;
    let token = null;
    if (idOrPayload && typeof idOrPayload === "object") {
      id = idOrPayload.id;
      token = idOrPayload.token;
      if (id == null && Number.isInteger(idOrPayload.index)) {
        id = currentDraft.options[idOrPayload.index]?.id;
      }
    }
    if (token != null && token !== currentDraft.token) return false; // stale pick
    const opt = currentDraft.options.find((o) => o.id === id) || currentDraft.options[0];
    if (!opt) return false;

    // Apply data-only, then notify. Other modules read ctx.upgrades.
    try { opt.apply(upgrades); } catch (_) { /* keep going — never wedge the run */ }
    if (!upgrades.taken.includes(opt.id)) upgrades.taken.push(opt.id);

    bus?.emit?.("upgrade", {
      effect: {
        id: opt.id,
        name: opt.name,
        tag: opt.tag,
        // snapshot of the resulting modifier values for any listener that wants them
        arrMult: upgrades.arrMult,
        pulseRateMult: upgrades.pulseRateMult,
        aoeRadiusMult: upgrades.aoeRadiusMult,
        seekerSlowMult: upgrades.seekerSlowMult,
        healOnFullStack: upgrades.healOnFullStack,
        forecast: upgrades.forecast,
      },
    });

    currentDraft = null;
    closeDraftUI();
    if (ctx.state) ctx.state.paused = false;
    // The click is a user gesture — best-effort re-lock so look resumes immediately.
    try { ctx.canvas?.requestPointerLock?.(); } catch (_) { /* controller may own this */ }
    return true;
  }

  // Internal picker (DOM). Self-contained so the run never soft-locks if no HUD handles it.
  let draftOverlay = null;
  let draftKeyHandler = null;
  function showDraftUI(draft) {
    if (!hasDOM) return; // headless: rely on external "draftPick"
    if (ctx.metaDraftUI === false) return; // integrator opted to render the picker elsewhere (HUD)
    ensureStyles();
    closeDraftUI();
    const ov = document.createElement("div");
    ov.className = "rrm-overlay rrm-draft";
    const cards = draft.options.map((o, i) => `
      <button class="rrm-up" data-id="${o.id}" type="button">
        <span class="rrm-up-key">${i + 1}</span>
        <span class="rrm-up-glyph">${o.glyph || "▣"}</span>
        <span class="rrm-up-name">${escapeHtml(o.name)}</span>
        <span class="rrm-up-tag">${escapeHtml(o.tag)}</span>
        <span class="rrm-up-desc">${escapeHtml(o.desc)}</span>
        <span class="rrm-up-go">Deploy →</span>
      </button>`).join("");
    ov.innerHTML = `
      <div class="rrm-draft-card">
        <div class="rrm-kicker">SECTOR CLEARED${draft.sector ? " · " + escapeHtml(draft.sector.toUpperCase()) : ""}</div>
        <div class="rrm-draft-title">Deploy an upgrade</div>
        <div class="rrm-draft-sub">Pick one — it sticks for the rest of the run.</div>
        <div class="rrm-up-row">${cards}</div>
      </div>`;
    ov.addEventListener("click", (e) => {
      const btn = e.target?.closest?.(".rrm-up");
      if (btn) applyPick(btn.getAttribute("data-id"));
    });
    document.body.appendChild(ov);
    draftOverlay = ov;
    try { document.exitPointerLock?.(); } catch (_) { /* ignore */ }
    requestAnimationFrame(() => ov.classList.add("rrm-show"));

    // 1/2/3 keyboard selection.
    draftKeyHandler = (ev) => {
      const k = ev.key;
      if (k === "1" || k === "2" || k === "3") {
        const opt = draft.options[Number(k) - 1];
        if (opt) { ev.preventDefault(); applyPick(opt.id); }
      }
    };
    document.addEventListener("keydown", draftKeyHandler);
  }
  function closeDraftUI() {
    if (draftOverlay) { try { draftOverlay.remove(); } catch (_) { /* ignore */ } draftOverlay = null; }
    if (draftKeyHandler && hasDOM) {
      try { document.removeEventListener("keydown", draftKeyHandler); } catch (_) { /* ignore */ }
      draftKeyHandler = null;
    }
  }

  // ── Last Stand (Focus) ───────────────────────────────────────────────────────
  function startFocus() {
    focusActive = true;
    lastStandUsed = true;
    focusTimer = FOCUS_DURATION;
    focusKills = 0;
    bus?.emit?.("lastStand", { active: true, duration: FOCUS_DURATION });
  }
  function endFocus() {
    focusActive = false;
    // Restore normal time ONLY if Focus is still the owner (don't cut an in-flight hitStop).
    if (ctx.state && (ctx.state.timeScale ?? 1) <= FOCUS_SCALE + 1e-3) ctx.state.timeScale = 1;
    let comeback = false;
    if (focusKills >= FOCUS_HEAL_KILLS && game) {
      // No public heal API; _modHealth clamps + is status-safe (won't flip a live run to lost).
      try {
        if (typeof game._modHealth === "function") game._modHealth(+COMEBACK_HEAL);
        else game.health = clamp(num(game.health) + COMEBACK_HEAL, 0, 100);
      } catch (_) { /* ignore */ }
      comeback = true;
    }
    bus?.emit?.("lastStand", { active: false, comeback, kills: focusKills });
  }

  // ── Frame step (timing in wall-clock; Last Stand re-caps timeScale after fx) ─────
  function step() {
    if (disposed || !game) return;
    const realDt = clamp(num(engine?.getDeltaTime?.()) / 1000, 0, 0.1) || 0.0167;
    const paused = !!ctx.state?.paused;
    const running = game.status === "running";

    // Trigger Focus once, when we drop into the danger band during live play.
    if (running && !paused && !focusActive && !lastStandUsed &&
        game.health > 0 && game.health <= LAST_STAND_HEALTH) {
      startFocus();
    }

    if (focusActive) {
      // Re-cap (don't force): lets fx hitStop dip BELOW 0.5 for punch, then we restore the
      // 0.5 Focus floor after fx snaps timeScale back to 1. Requires meta to run after fx.
      if (ctx.state && (ctx.state.timeScale ?? 1) > FOCUS_SCALE) ctx.state.timeScale = FOCUS_SCALE;
      // Burn the window in wall-clock time, but freeze it while a draft modal is up.
      if (!paused) {
        focusTimer -= realDt;
        if (focusTimer <= 0 || !running) endFocus();
      }
    }
  }

  // ── Bus wiring ───────────────────────────────────────────────────────────────
  const handlers = [];
  function on(name, fn) {
    if (!bus?.on) return;
    bus.on(name, fn);
    handlers.push([name, fn]);
  }

  on("start", () => { resetRun(); });

  on("zone", (e = {}) => {
    if (disposed || game?.status !== "running") return;
    // world re-arms to -1 on start, so Connect (index 0) re-announces every run: never draft it.
    // De-dupe by index so a backtrack into an already-cleared sector won't re-offer a draft.
    const idx = sectorIndexFor(e);
    if (idx <= 0 || draftedSectors.has(idx)) return;
    draftedSectors.add(idx);
    openDraft(idx, e.name);
  });

  // External pick path (e.g. a HUD-rendered picker) routes through the same apply-once code.
  on("draftPick", (e) => { applyPick(e); });

  // Track Full-Stack catches (for the summary + Auto-Renew) and Focus-window catches.
  on("kill", (e = {}) => {
    if (disposed) return;
    const chips = num(KIND_CHIPS[e.kind], 0);
    if (chips >= FULLSTACK_CHIPS) {
      fullStackCount += 1;
      if (upgrades.healOnFullStack && game) {
        try {
          if (typeof game._modHealth === "function") game._modHealth(+AUTORENEW_HEAL);
          else game.health = clamp(num(game.health) + AUTORENEW_HEAL, 0, 100);
        } catch (_) { /* ignore */ }
      }
    }
    if (focusActive && !ctx.state?.paused) focusKills += 1;
  });

  function endRun(won) {
    if (disposed) return;
    // If a draft was somehow still open at run end, clear the modal/pause.
    if (currentDraft) { currentDraft = null; closeDraftUI(); if (ctx.state) ctx.state.paused = false; }
    if (focusActive) endFocus();
    const summary = buildSummary(won);
    lastSummary = summary;
    try { recordRun(summary); } catch (_) { /* storage blocked — non-fatal */ }
    // Delegate the rich result card to brand when present; else show our minimal fallback.
    if (typeof ctx.brand?.showResult === "function") {
      try { ctx.brand.showResult(summary); } catch (_) { showFallbackResult(summary); }
    } else {
      showFallbackResult(summary);
    }
  }
  on("win", () => endRun(true));
  on("lose", () => endRun(false));

  if (onFrame) onFrame(step);

  // ── Styles (sharp, bright, premium-glass — matches Quivly's light "real world" look) ──
  let styleEl = null;
  function ensureStyles() {
    if (styleEl || !hasDOM) return;
    styleEl = document.createElement("style");
    styleEl.id = "rrm-style";
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (bus?.off) for (const [n, fn] of handlers) { try { bus.off(n, fn); } catch (_) { /* ignore */ } }
    handlers.length = 0;
    closeDraftUI();
    closeFallbackResult();
    currentDraft = null;
    // Never leave the run wedged: clear pause + restore time.
    if (ctx.state) { ctx.state.paused = false; ctx.state.timeScale = 1; }
    if (styleEl) { try { styleEl.remove(); } catch (_) { /* ignore */ } styleEl = null; }
  }

  return {
    // Stickiness reads for HUD / title screen.
    getBest,
    getLeaderboard,
    // Daily / Endless.
    getMode: () => mode,
    setMode,
    getSeed: () => runSeed(),
    // Upgrades + last run.
    getUpgrades: () => upgrades,
    getSummary: () => lastSummary,
    // Sharing + lifecycle.
    share,
    dispose,
  };
}

// Resolve a sector index from the "zone" payload. world emits { name }, not an index, so we
// map the known sector names back to their order; unknown names fall back to a stable hash.
const SECTOR_ORDER = { connect: 0, see: 1, surface: 1, score: 2, deploy: 2, act: 3, renewal: 3 };
function sectorIndexFor(e) {
  if (Number.isInteger(e?.index)) return e.index;
  const key = String(e?.name || "").trim().toLowerCase();
  if (key in SECTOR_ORDER) return SECTOR_ORDER[key];
  return 1 + (hashStr(key) % 3); // unknown but non-Connect → still draftable, deterministically
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Bright, high-definition glass UI. Light scrim + indigo accent, crisp type, hover lift —
// deliberately NOT the rejected dark techno look.
const CSS = `
.rrm-overlay{position:fixed;inset:0;z-index:2147482600;display:flex;align-items:center;justify-content:center;
 font-family:Inter,'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;padding:24px;box-sizing:border-box;
 background:radial-gradient(1200px 800px at 50% 18%,rgba(99,102,241,.22),rgba(15,18,38,.66)),rgba(12,14,28,.5);
 -webkit-backdrop-filter:blur(8px) saturate(125%);backdrop-filter:blur(8px) saturate(125%);
 opacity:0;transition:opacity .32s ease;}
.rrm-overlay.rrm-show{opacity:1;}
.rrm-draft-card,.rrm-card{background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(244,246,255,.94));
 border:1px solid rgba(99,102,241,.35);border-radius:22px;padding:30px 34px;box-sizing:border-box;
 box-shadow:0 36px 90px -28px rgba(20,24,60,.65),0 0 60px -20px rgba(99,102,241,.55);
 transform:translateY(14px) scale(.985);transition:transform .5s cubic-bezier(.16,1,.3,1);max-width:min(96vw,940px);width:100%;}
.rrm-overlay.rrm-show .rrm-draft-card,.rrm-overlay.rrm-show .rrm-card{transform:none;}
.rrm-kicker{font-weight:800;font-size:13px;letter-spacing:1.6px;color:#6366F1;text-transform:uppercase;}
.rrm-draft-title{font-weight:800;font-size:40px;line-height:1.05;color:#0c1024;margin-top:8px;letter-spacing:-.5px;}
.rrm-draft-sub{font-weight:500;font-size:17px;color:#5a6080;margin-top:6px;}
.rrm-up-row{display:flex;gap:16px;margin-top:24px;flex-wrap:wrap;}
.rrm-up{flex:1 1 220px;min-width:200px;text-align:left;cursor:pointer;position:relative;
 background:linear-gradient(180deg,#ffffff,#f3f5ff);border:1.5px solid rgba(99,102,241,.28);border-radius:16px;
 padding:22px 20px 18px;display:flex;flex-direction:column;gap:6px;color:#0c1024;
 box-shadow:0 10px 28px -16px rgba(40,46,100,.5);transition:transform .16s ease,border-color .18s ease,box-shadow .18s ease;}
.rrm-up:hover,.rrm-up:focus-visible{transform:translateY(-6px);border-color:#6366F1;outline:none;
 box-shadow:0 22px 48px -18px rgba(79,70,229,.6),0 0 0 3px rgba(99,102,241,.18);}
.rrm-up-key{position:absolute;top:12px;right:14px;width:24px;height:24px;border-radius:7px;font-size:13px;font-weight:800;
 color:#6366F1;background:rgba(99,102,241,.12);display:flex;align-items:center;justify-content:center;}
.rrm-up-glyph{font-size:30px;line-height:1;}
.rrm-up-name{font-weight:800;font-size:22px;letter-spacing:-.3px;}
.rrm-up-tag{font-weight:700;font-size:13px;color:#4F46E5;background:rgba(99,102,241,.12);
 align-self:flex-start;padding:3px 9px;border-radius:999px;letter-spacing:.2px;}
.rrm-up-desc{font-weight:500;font-size:14px;line-height:1.4;color:#5a6080;margin-top:2px;}
.rrm-up-go{margin-top:auto;font-weight:800;font-size:14px;color:#6366F1;padding-top:10px;}
.rrm-card{display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:min(94vw,560px);}
.rrm-title{font-weight:800;font-size:46px;color:#0c1024;letter-spacing:-.6px;margin-top:6px;}
.rrm-arr{font-weight:800;font-size:64px;color:#4F46E5;letter-spacing:-1px;line-height:1;margin-top:10px;}
.rrm-sub{font-weight:600;font-size:16px;color:#5a6080;margin-top:4px;}
.rrm-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px;width:100%;}
.rrm-btn{appearance:none;border:1px solid rgba(99,102,241,.3);background:#fff;color:#0c1024;
 font:700 15px/1 inherit;padding:13px 20px;border-radius:12px;cursor:pointer;text-decoration:none;
 display:inline-flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .18s ease;}
.rrm-btn:hover{transform:translateY(-2px);box-shadow:0 14px 30px -14px rgba(40,46,100,.55);}
.rrm-primary{background:linear-gradient(180deg,#6366F1,#4F46E5);border-color:transparent;color:#fff;
 box-shadow:0 14px 32px -10px rgba(79,70,229,.7);}
.rrm-foot{font-weight:600;font-size:14px;color:#5a6080;margin-top:18px;}
@media (max-width:560px){.rrm-up{flex:1 1 100%;}.rrm-btn{flex:1 1 44%;}.rrm-draft-title{font-size:32px;}}
@media (prefers-reduced-motion:reduce){.rrm-overlay,.rrm-draft-card,.rrm-card,.rrm-up{transition-duration:.01ms;}}
`;
