// Renewal Rush — HUD (Phase 1 + 5).
// A super-sharp, high-definition "Customer 360" dashboard rendered as a plain
// HTML/CSS overlay bound to the pure game loop. Premium dark glass + Quivly forest emerald,
// retina-crisp typography (tabular numerics, no text blur), high info density.
//
// What it renders (Quivly framing, real product nouns):
//   • Renewal Day countdown (mm:ss, urgent red < 20s) — the hero metric.
//   • ARR Saved · Multiplier · Deploys · Full Stack catch counter (top pills).
//   • Customer 360 · Health Score: big numeric (0–100) + trend arrow (▲▼—) +
//     risk bucket color (Critical→High→Medium→Healthy) + bar w/ renewal line @40.
//   • Radar · Churn Threat bar.
//   • Rank strip (named ARR ranks Renewal Rookie → Chief Renewal Officer) with
//     "next rank in $X" progress.
//   • Actions feed: a live play-by-play of agent deploys (Quivly voice).
//   • Title screen, per-sector intro toasts, and a non-blocking win/lose
//     cinematic using the exact script beats from QUIVLY-GROUNDING.md.
//   • META: "Best: $X" (localStorage), OVERTIME / Expansion Run banner, active
//     mutator chip, and the 1-of-3 UPGRADE DRAFT card UI (bus "draft" → "draft:pick").
//   • Three-state crosshair, floating +ARR numbers, callouts, Last Stand banner,
//     and a SUBTLE low-health EDGE vignette (never a full-screen wash).
//
// Contract (ARCHITECTURE.md): one factory `createHud(ctx)`, all per-frame work via
// ctx.onFrame, returns { update, dispose }. Babylon is touched ONLY to project a
// 3D kill position to overlay px (math.vector is already in the bundle) — no new
// Babylon imports, everything else is DOM. Degrades gracefully when optional
// collaborators (scene/camera/fx/bus/state) are absent.
//
// Cooperative seams worth calling out:
//   • brand.js OWNS the shareable end RESULT CARD (z 2147483000, share/CTA/replay).
//     The HUD must NOT duplicate or touch it — our win/lose cinematic is a separate
//     body-level layer ABOVE brand, ALWAYS pointer-events:none + auto-fading, so
//     brand's buttons stay clickable. We never call brand.showResult.
//   • The HUD is the de-facto owner of modal pause: it sets state.paused while the
//     title / upgrade-draft overlays are open and ALWAYS restores it (incl. dispose).
//   • Last Stand is PRESENTATION ONLY here (banner + focus vignette). The slow-mo
//     itself is fx's job (fx owns state.timeScale — the HUD never writes it).

import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { RENEWAL_MS, COMBO_TIERS, WIN_HEALTH } from "./game.js";

const STYLE_ID = "rr-hud-style";
const BEST_KEY = "rr.best.arr";

// Brand palette (kept in sync with ARCHITECTURE.md / brand.js).
const C = {
  accent: "#2BD98A",
  accentSoft: "#6EE7B7",
  bg: "#0A0A0A",
  success: "#34D399",
  warning: "#FBBF24",
  risk: "#F87171",
  gold: "#FCD34D",
};

// Named ARR ranks (DESIGN.md §4) — HUD-local meta presentation.
const ARR_RANKS = [
  { name: "Renewal Rookie", min: 0 },
  { name: "Account Defender", min: 5_000 },
  { name: "CSM Speedrunner", min: 15_000 },
  { name: "VP Retention", min: 40_000 },
  { name: "Chief Renewal Officer", min: 80_000 },
];

// Exact script beats (QUIVLY-GROUNDING.md §"Script beats"). Connect is verbatim;
// See/Score/Act are tightly derived from the sector-flow descriptions (L57–60).
const SCRIPT = {
  titleName: "RENEWAL RUSH",
  titleTag: "Every signal. One place. 90 seconds to renewal day.",
  aha: "CRM said healthy. Usage said otherwise. Quivly saw both.",
  champion: "Your champion is walking out — Slack quiet, Stripe failed, Market says layoffs. One card. Deploy.",
  win: "You saved the quarter. Renewal closed-won. ARR secured — your post-sales team, without the headcount.",
  lose: "Churn got there first. The account went dark. Quivly would've had the draft ready.",
  cta: "This is a game. Quivly does it for real, autonomously, across your whole stack. → quivly.ai",
};

// Per-sector intro toasts (Connect verbatim; See/Score/Act derived in Quivly voice).
const SECTORS = {
  connect: {
    title: "CONNECT · Integrations",
    line: "Your stack is scattered — Salesforce, Gong, Stripe, Zendesk, Slack, Market. Watch it become one profile.",
  },
  see: {
    title: "SEE · Customer 360",
    line: "Customer 360 is live. Every signal surfaces as a card — Radar is watching the whole account.",
  },
  score: {
    title: "SCORE · Insight Ledger",
    line: "Health Score is sliding. The Insight Ledger gates risk into Actions — triage the worst first.",
  },
  act: {
    title: "ACT · Actions & Agents",
    line: "Actions feed is hot. The draft's already written — deploy and save the renewal at the gate.",
  },
};

// Real integration sources + signal nouns for flavor in the Actions feed.
const SOURCE_POOL = ["Salesforce", "HubSpot", "Stripe", "Amplitude", "Gong", "Zendesk", "Slack", "Market"];
const SIGNAL_NOUNS = [
  "Declining usage", "Low product adoption", "Payment overdue", "Renewal approaching",
  "Negative sentiment", "Support escalation", "No activity 30d", "Low health score",
  "Negative market signal", "Champion at risk",
];

// Fallback upgrade-draft pool (DESIGN.md §4) — used only when the "draft" event
// arrives without explicit options (so the card UI is always demonstrable).
const DRAFT_POOL = [
  { id: "webhook", name: "Webhook", glyph: "⇄", tag: "Deploy rate", desc: "Agents fire faster. +25% pulse rate." },
  { id: "data-lake", name: "Data Lake", glyph: "≣", tag: "Revenue", desc: "Every save pays more. +15% ARR." },
  { id: "auto-renew", name: "Auto-Renew", glyph: "↻", tag: "Health", desc: "Full Stack catches restore portfolio health." },
  { id: "sentiment", name: "Sentiment Engine", glyph: "◍", tag: "Control", desc: "Nearby churn seekers slow down." },
  { id: "forecast", name: "Forecast", glyph: "◎", tag: "Radar", desc: "See the next signal before it spawns." },
  { id: "skill", name: "Skill Template", glyph: "✦", tag: "AoE", desc: "Wider deploy blast radius." },
];

export function createHud(ctx = {}) {
  const { engine, scene, camera, canvas, game, bus, onFrame, state } = ctx;

  injectStyle();

  // --- container (reuse #hud if a host provided one; never clobber it) -------
  let host = (typeof document !== "undefined" && document.getElementById("hud")) || null;
  let createdHost = false;
  if (!host && typeof document !== "undefined") {
    host = document.createElement("div");
    host.id = "hud";
    (canvas?.parentElement || document.body).appendChild(host);
    createdHost = true;
  }

  // Our own layer so we own a clean subtree (and a clean teardown).
  const root = document.createElement("div");
  root.className = "rr-hud";
  root.innerHTML = TEMPLATE;
  host.appendChild(root);

  // The win/lose cinematic must beat brand.js's result card (z 2147483000).
  // A descendant of `root` (z30, its own stacking context) could never rise
  // above it, so the cinematic lives in a SEPARATE body-level layer.
  const endLayer = document.createElement("div");
  endLayer.className = "rr-endlayer";
  endLayer.innerHTML = END_TEMPLATE;
  (typeof document !== "undefined" ? document.body : host).appendChild(endLayer);

  // --- element refs ---------------------------------------------------------
  const $ = (sel) => root.querySelector(sel);
  const el = {
    // top pills
    arr: $("[data-arr]"),
    mult: $("[data-mult]"),
    multPill: $(".rr-pill--mult"),
    deploys: $("[data-deploys]"),
    fsPill: $(".rr-pill--fs"),
    fsCount: $("[data-fscount]"),
    // brand + chips
    bestChip: $("[data-best]"),
    mutChip: $("[data-mutator]"),
    // timer
    timer: $("[data-timer]"),
    timerWrap: $(".rr-timer"),
    timerLabel: $("[data-timerlabel]"),
    timeFill: $("[data-timefill]"),
    // health (Customer 360)
    healthWrap: $(".rr-health"),
    healthScore: $("[data-healthscore]"),
    healthTrend: $("[data-healthtrend]"),
    healthBucket: $("[data-healthbucket]"),
    healthFill: $("[data-healthfill]"),
    // threat (Radar)
    threatWrap: $(".rr-threat"),
    threatVal: $("[data-threatval]"),
    threatFill: $("[data-threatfill]"),
    // rank strip
    rankName: $("[data-rankname]"),
    rankNext: $("[data-ranknext]"),
    rankFill: $("[data-rankfill]"),
    // actions feed
    actionsList: $(".rr-actions__list"),
    // center stack
    combo: $(".rr-combo"),
    comboNum: $("[data-combo]"),
    cross: $(".rr-cross"),
    callout: $(".rr-callout"),
    fsBadge: $(".rr-fsbadge"),
    fsBadgeSrc: $("[data-fssources]"),
    announce: $(".rr-announce"),
    // focus + style rail (Total Overdose juice)
    styleWrap: $(".rr-style"),
    styleRank: $("[data-stylerank]"),
    styleMult: $("[data-stylemult]"),
    styleFill: $("[data-stylefill]"),
    focusWrap: $(".rr-focus"),
    focusState: $("[data-focusstate]"),
    focusFill: $("[data-focusfill]"),
    // banners
    zone: $(".rr-zone"),
    zoneTitle: $("[data-zonetitle]"),
    zoneLine: $("[data-zoneline]"),
    overtime: $(".rr-overtime"),
    laststand: $(".rr-laststand"),
    // effects
    vignette: $(".rr-vignette"),
    floaters: $(".rr-floaters"),
    // title
    title: $(".rr-title"),
    titleBest: $("[data-titlebest]"),
    titleMut: $("[data-titlemutator]"),
    titleCta: $(".rr-title__cta"),
    // draft
    draft: $(".rr-draft"),
    draftCards: $(".rr-draft__cards"),
    // end cinematic (separate body layer)
    end: endLayer.querySelector(".rr-end"),
    endLine: endLayer.querySelector("[data-endline]"),
    endStats: endLayer.querySelector("[data-endstats]"),
  };

  // --- per-frame write cache (skip DOM churn when values are unchanged) -----
  const cache = {
    arr: -1, timer: "", timeFrac: -1, deploys: -1, mult: -1,
    health: -1, threat: -1, combo: -1, crossKind: "init",
    low: null, urgent: null, ended: "", trend: "", rank: "",
    focus: -1, focusReady: null, styleBar: -1,
  };

  // --- run/meta state -------------------------------------------------------
  let disposed = false;
  let best = loadBest();
  let mutatorName = null;
  let startedOnce = false;
  let titleShown = false;
  let titlePaused = false;
  let draftPaused = false;
  let draftPayload = null;
  let fullStackCount = 0;
  let ahaShown = false;
  let lastStandShown = false;
  let overtimeActive = false;
  let feedRot = 0;
  let nounRot = 0;
  let aim = null; // optional { kind, t } override from a "combat" aim event
  const offs = []; // bus unsubscribe fns
  const timers = []; // pending setTimeout ids (for teardown)
  const trendBuf = []; // { t, h } health samples for the trend arrow
  let lastTrendAt = 0;
  let lastTrendPush = 0;
  // Total Overdose: style-rank + focus-meter presentation state.
  let styleRankIdx = -1; // -1 = none yet (so first "style" pops on increase)
  let styleMult = 1; // style-rank ARR multiplier (from bus "style"; NOT the combo Mult pill)
  let styleCharge = 0; // 0..1 recency charge for the decaying style points bar
  let lastStyleDecayAt = 0;

  updateBestChips();

  // Position the renewal-threshold marker on the health bar from WIN_HEALTH,
  // so it tracks the real win line (≥40) rather than a hardcoded value.
  const healthMark = root.querySelector(".rr-bar__mark");
  if (healthMark) {
    healthMark.style.left = `${WIN_HEALTH}%`;
    healthMark.dataset.label = String(WIN_HEALTH);
  }

  // ---- helpers -------------------------------------------------------------
  const truthy = (v) => (typeof v === "function" ? v() : v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function later(fn, ms) {
    const id = setTimeout(() => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
      if (!disposed) fn();
    }, ms);
    timers.push(id);
    return id;
  }

  function on(name, fn) {
    if (!bus?.on) return;
    const off = bus.on(name, fn);
    if (typeof off === "function") offs.push(off);
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function fmtMoney(n) { return `$${Math.round(n || 0).toLocaleString("en-US")}`; } // hoisted: updateBestChips() runs during createHud, before this line

  function loadBest() {
    try { return Math.max(0, parseInt(localStorage.getItem(BEST_KEY) || "0", 10) || 0); }
    catch { return 0; }
  }
  function saveBest(v) {
    if (!(v > best)) return;
    best = v;
    try { localStorage.setItem(BEST_KEY, String(Math.round(v))); } catch { /* embed may block storage */ }
  }

  function rankFor(arr) {
    let i = 0;
    for (let k = 0; k < ARR_RANKS.length; k++) if (arr >= ARR_RANKS[k].min) i = k;
    const cur = ARR_RANKS[i];
    const next = ARR_RANKS[i + 1] || null;
    const span = next ? next.min - cur.min : 1;
    const prog = next ? Math.max(0, Math.min(1, (arr - cur.min) / span)) : 1;
    const remaining = next ? Math.max(0, next.min - arr) : 0;
    return { name: cur.name, next, prog, remaining };
  }

  function chipsForKind(k) {
    return k === "boss" ? 5 : k === "shielded" ? 3 : k === "elite" ? 2 : k === "churn" ? 2 : 1;
  }
  function humanize(s) {
    const t = String(s || "").trim();
    if (!t) return "";
    if (/[_\s]/.test(t) || t === t.toLowerCase()) {
      return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return t;
  }
  function pickNoun() { return SIGNAL_NOUNS[(nounRot++) % SIGNAL_NOUNS.length]; }
  function groundedIn(n) {
    const start = feedRot % SOURCE_POOL.length;
    const picks = [];
    const k = Math.max(1, Math.min(n, 3));
    for (let i = 0; i < k; i++) picks.push(SOURCE_POOL[(start + i) % SOURCE_POOL.length]);
    return picks.join(" + ");
  }

  function updateBestChips() {
    const t = `Best ${fmtMoney(best)}`;
    if (el.bestChip) el.bestChip.textContent = t;
    if (el.titleBest) el.titleBest.textContent = t;
  }
  function updateMutatorChips() {
    const show = !!mutatorName;
    if (el.mutChip) { el.mutChip.hidden = !show; if (show) el.mutChip.textContent = `Mutator · ${mutatorName}`; }
    if (el.titleMut) { el.titleMut.hidden = !show; if (show) el.titleMut.textContent = `Mutator · ${mutatorName}`; }
  }

  // Restart a CSS keyframe animation by toggling its class.
  function restart(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth; // force reflow
    node.classList.add(cls);
  }

  // ---- crosshair source: project a 3D world point to overlay px ------------
  function project(pos) {
    try {
      if (!pos || !scene?.getTransformMatrix || !engine || !camera?.viewport) return null;
      const v3 = pos instanceof Vector3 ? pos : new Vector3(pos.x || 0, pos.y || 0, pos.z || 0);
      const w = engine.getRenderWidth();
      const h = engine.getRenderHeight();
      const p = Vector3.Project(v3, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
      if (!isFinite(p.x) || !isFinite(p.y) || p.z < 0 || p.z > 1) return null;
      const rect = canvas?.getBoundingClientRect?.() || { left: 0, top: 0, width: w, height: h };
      return { x: rect.left + (p.x / w) * rect.width, y: rect.top + (p.y / h) * rect.height };
    } catch {
      return null;
    }
  }

  function centerPt() {
    const rect = canvas?.getBoundingClientRect?.();
    if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.42 };
    return { x: (window.innerWidth || 800) / 2, y: (window.innerHeight || 600) * 0.42 };
  }

  // Continuous reticle feedback: nearest pick under the camera-forward ray.
  function aimKind() {
    if (aim && performance.now() - aim.t < 150) return aim.kind || null;
    try {
      const ray = camera?.getForwardRay?.(160);
      if (!ray || !scene?.pickWithRay) return null;
      const pick = scene.pickWithRay(ray, (m) => !!m?.metadata?.onHit); // nearest, not fastCheck
      return pick?.hit ? pick.pickedMesh?.metadata?.kind || null : null;
    } catch {
      return null;
    }
  }

  // ---- floaters ------------------------------------------------------------
  function floater(text, kind, pt) {
    if (!el.floaters || disposed) return;
    const f = document.createElement("div");
    f.className = `rr-float rr-float--${kind}`;
    f.textContent = text;
    const drift = (Math.random() * 2 - 1) * 26;
    f.style.setProperty("--dx", `${drift.toFixed(0)}px`);
    f.style.left = `${(pt?.x ?? centerPt().x).toFixed(0)}px`;
    f.style.top = `${(pt?.y ?? centerPt().y).toFixed(0)}px`;
    el.floaters.appendChild(f);
    while (el.floaters.childElementCount > 40) el.floaters.firstElementChild.remove();
    f.addEventListener("animationend", () => f.remove(), { once: true });
    later(() => f.isConnected && f.remove(), 1600);
  }

  function callout(text, kind = "accent") {
    if (!el.callout) return;
    el.callout.textContent = text;
    el.callout.dataset.kind = kind;
    restart(el.callout, "rr-show");
  }

  // ---- announcer line (bus "announce") -------------------------------------
  // Big, centered, distinct from the small banter callout. tone -> color ramp:
  //   focus=indigo · style=magenta · risk=red · win=green · (default ink).
  function announce(text, tone = "style") {
    if (!el.announce || !text) return;
    el.announce.textContent = String(text);
    el.announce.dataset.tone = String(tone || "style");
    restart(el.announce, "rr-show");
  }

  // ---- style meter (bus "style" {rank,mult,points}) ------------------------
  // rank/mult/color are HELD from the last event (a rank drop is itself a
  // "style" change). Only the bar decays — driven as a recency charge so it
  // reads as "build up, decays when you stop", regardless of `points` units.
  const STYLE_RANKS = ["cool", "hot", "loco", "overdose"];
  function styleIdx(rank) {
    const i = STYLE_RANKS.indexOf(String(rank || "").toLowerCase());
    return i < 0 ? 0 : i;
  }
  function applyStyle(e = {}) {
    const idx = styleIdx(e.rank);
    if (Number.isFinite(Number(e.mult))) styleMult = Number(e.mult);
    styleCharge = 1; // refill on any style activity
    const name = String(e.rank || STYLE_RANKS[idx]).toUpperCase();
    if (el.styleRank) el.styleRank.textContent = name;
    if (el.styleMult) el.styleMult.textContent = `×${Number.isInteger(styleMult) ? styleMult : styleMult.toFixed(1)}`;
    if (el.styleWrap) {
      el.styleWrap.dataset.rank = STYLE_RANKS[idx];
      el.styleWrap.classList.toggle("rr-style--overdose", idx >= 3);
      if (idx > styleRankIdx) restart(el.styleWrap, "rr-style--pop"); // punch on rank-up
    }
    styleRankIdx = idx;
  }

  // ---- big +ARR kill popup (bolder variant of floater()) -------------------
  function killPopup(arr, kind, pt) {
    if (!el.floaters || disposed) return;
    const f = document.createElement("div");
    f.className = `rr-kill rr-kill--${kind}`;
    f.textContent = `+${fmtMoney(arr)}`;
    // Scale by reward size; Full-Stack / boss get extra punch.
    const big = kind === "boss" ? 1.9 : kind === "full" ? 1.5 : Math.min(1.5, 1 + arr / 6000);
    f.style.setProperty("--pk", big.toFixed(2));
    const drift = (Math.random() * 2 - 1) * 30;
    f.style.setProperty("--dx", `${drift.toFixed(0)}px`);
    f.style.left = `${(pt?.x ?? centerPt().x).toFixed(0)}px`;
    f.style.top = `${(pt?.y ?? centerPt().y).toFixed(0)}px`;
    el.floaters.appendChild(f);
    while (el.floaters.childElementCount > 40) el.floaters.firstElementChild.remove();
    f.addEventListener("animationend", () => f.remove(), { once: true });
    later(() => f.isConnected && f.remove(), 1800);
  }

  // ---- actions feed (Quivly play-by-play) ----------------------------------
  function pushAction(text, kind = "signal") {
    if (!el.actionsList || disposed) return;
    const li = document.createElement("div");
    li.className = `rr-act rr-act--${kind}`;
    li.textContent = text;
    el.actionsList.prepend(li);
    while (el.actionsList.childElementCount > 5) el.actionsList.lastElementChild.remove();
    later(() => {
      if (!li.isConnected) return;
      li.classList.add("rr-act--out");
      later(() => li.isConnected && li.remove(), 420);
    }, 4200);
  }

  // ---- full-stack center badge --------------------------------------------
  function showFsBadge(sources) {
    if (!el.fsBadge) return;
    if (el.fsBadgeSrc) el.fsBadgeSrc.textContent = `${sources} sources`;
    restart(el.fsBadge, "rr-show");
  }

  // ---- shakes / vignette ---------------------------------------------------
  function shake(cls) {
    restart(root, cls);
    later(() => root.classList.remove(cls), 360);
  }
  function flashVignette(cls, intensity = 0.7) {
    if (!el.vignette) return;
    el.vignette.style.setProperty("--hit", intensity.toFixed(2));
    restart(el.vignette, `rr-v--${cls}`);
    later(() => el.vignette.classList.remove(`rr-v--${cls}`), 360);
  }

  // ---- reveal / title ------------------------------------------------------
  function reveal() { root.classList.add("rr-active"); }

  function showTitle() {
    if (!el.title || titleShown) return;
    titleShown = true;
    reveal();
    updateBestChips();
    updateMutatorChips();
    // The game auto-starts; freeze it while the player reads the title.
    if (state) { titlePaused = true; state.paused = true; }
    el.title.classList.add("rr-show");
  }

  function beginPlay() {
    // Guard against double-fire (button click bubbles to the overlay listener).
    if (!el.title || !el.title.classList.contains("rr-show")) return;
    el.title.classList.remove("rr-show");
    if (state && titlePaused) { state.paused = false; titlePaused = false; }
    reveal();
    // Best-effort lock from the user gesture (controller mirrors state.locked).
    try { canvas?.requestPointerLock?.(); } catch { /* embed may block */ }
  }
  // Click anywhere on the title (incl. the CTA button, which bubbles) to begin.
  if (el.title) el.title.addEventListener("click", beginPlay);

  // ---- upgrade draft (1-of-3) ---------------------------------------------
  // Contract extension: a collaborator emits  bus.emit("draft", { options?, onPick?, resolve? }).
  // Each option = { id, name, desc, glyph?, tag? }. The HUD renders the cards and,
  // on pick, emits  bus.emit("draft:pick", { id, option, index })  AND calls
  // payload.onPick(option) / payload.resolve(option) if provided.
  function defaultDraft() {
    const a = DRAFT_POOL.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, 3);
  }
  function renderDraft(opts) {
    if (!el.draftCards) return;
    el.draftCards.innerHTML = "";
    opts.forEach((opt, idx) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "rr-card rr-card--" + (idx % 3); // per-option accent (emerald/cyan/gold)
      card.innerHTML =
        `<span class="rr-card__glyph">${esc(opt.glyph || "✦")}</span>` +
        `<span class="rr-card__tag">${esc(opt.tag || "Upgrade")}</span>` +
        `<strong class="rr-card__name">${esc(opt.name || "Upgrade")}</strong>` +
        `<span class="rr-card__desc">${esc(opt.desc || "")}</span>` +
        `<span class="rr-card__pick">Deploy this ▸</span>`;
      card.addEventListener("click", () => pickDraft(opt, idx));
      el.draftCards.appendChild(card);
    });
  }
  function openDraft(e = {}) {
    if (!el.draft || disposed) return;
    const opts = (Array.isArray(e.options) && e.options.length) ? e.options.slice(0, 3) : defaultDraft();
    draftPayload = e;
    renderDraft(opts);
    if (state) { draftPaused = true; state.paused = true; }
    try { document.exitPointerLock?.(); } catch { /* noop */ }
    el.draft.classList.add("rr-show");
  }
  function pickDraft(opt, idx) {
    if (el.draft) el.draft.classList.remove("rr-show");
    if (state && draftPaused) { state.paused = false; draftPaused = false; }
    try { bus?.emit?.("draft:pick", { id: opt.id, option: opt, index: idx }); } catch { /* noop */ }
    try { draftPayload?.onPick?.(opt); } catch { /* noop */ }
    try { draftPayload?.resolve?.(opt); } catch { /* noop */ }
    draftPayload = null;
    callout(`UPGRADE · ${String(opt.name || "").toUpperCase()}`, "accent");
    pushAction(`Upgrade deployed · ${opt.name}`, "muted");
    try { canvas?.requestPointerLock?.(); } catch { /* noop */ }
  }

  // ---- overtime / last stand ----------------------------------------------
  function startOvertime() {
    if (overtimeActive) return;
    overtimeActive = true;
    hideEnd();
    if (el.timerLabel) el.timerLabel.textContent = "Expansion Run";
    if (el.overtime) restart(el.overtime, "rr-show");
    // No callout here: the persistent .rr-overtime banner already announces this. Firing
    // both showed the SAME update as two slightly-different texts ("· " vs "— "). One source.
  }
  function triggerLastStand() {
    if (lastStandShown || overtimeActive) return;
    lastStandShown = true;
    if (el.laststand) restart(el.laststand, "rr-show");
    // No callout here: the persistent .rr-laststand banner already announces this (same
    // double-text issue as overtime). One source per update.
  }

  // ---- end cinematic (layered above brand, never blocking) -----------------
  function hideEnd() { el.end?.classList.remove("rr-show"); }
  function endState(which) {
    if (cache.ended) return;
    cache.ended = which;
    reveal();
    root.classList.add("rr-over", which === "won" ? "rr-won" : "rr-lost");

    let snap = null;
    try { snap = game?.snapshot?.(); } catch { /* optional */ }
    const arr = snap?.arr ?? 0;
    saveBest(arr);
    updateBestChips();

    // Overtime supersedes the win banner (the run continues — no end card moment).
    if (overtimeActive && which === "won") return;

    const r = rankFor(arr);
    if (el.endLine) el.endLine.textContent = which === "won" ? SCRIPT.win : SCRIPT.lose;
    if (el.endStats) {
      el.endStats.textContent =
        `ARR Saved ${fmtMoney(arr)}  ·  Rank ${r.name}  ·  Deploys ${snap?.deploys ?? 0}` +
        `  ·  Full Stack ×${fullStackCount}  ·  Best ${fmtMoney(best)}`;
    }
    if (el.end) {
      el.end.dataset.kind = which;
      restart(el.end, "rr-show");
      later(hideEnd, 7200); // yields the screen to brand.js's result card
    }
  }

  // ---- event wiring --------------------------------------------------------
  on("start", () => {
    cache.ended = "";
    root.classList.remove("rr-over", "rr-won", "rr-lost");
    hideEnd();
    // reset per-run meta presentation
    fullStackCount = 0;
    ahaShown = false;
    lastStandShown = false;
    overtimeActive = false;
    feedRot = 0;
    nounRot = 0;
    trendBuf.length = 0;
    cache.trend = "";
    // reset Total Overdose presentation
    styleRankIdx = -1;
    styleMult = 1;
    styleCharge = 0;
    cache.focus = -1;
    cache.focusReady = null;
    cache.styleBar = -1;
    if (el.styleWrap) { el.styleWrap.dataset.rank = "cool"; el.styleWrap.classList.remove("rr-style--overdose"); }
    if (el.styleRank) el.styleRank.textContent = "COOL";
    if (el.styleMult) el.styleMult.textContent = "×1";
    if (el.styleFill) el.styleFill.style.width = "0%";
    if (el.focusWrap) el.focusWrap.classList.remove("rr-focus--ready");
    if (el.focusFill) el.focusFill.style.width = "0%";
    if (el.focusState) el.focusState.textContent = "CHARGING";
    if (el.fsCount) el.fsCount.textContent = "0";
    if (el.actionsList) el.actionsList.innerHTML = "";
    if (el.timerLabel) el.timerLabel.textContent = "Renewal Day";
    // Title only on the very first start; replays (brand "Play again") are instant.
    if (!startedOnce) { startedOnce = true; showTitle(); }
    else reveal();
  });

  on("kill", (e = {}) => {
    reveal();
    const arr = Number(e.arr) || 0;
    const kind = e.kind || "signal";
    const sources = Number(e.sources ?? e.chips ?? chipsForKind(kind)) || 1;
    const fullStack = sources >= 2;
    const floatKind = kind === "boss" ? "boss" : fullStack ? "full" : "signal";
    if (arr > 0) killPopup(arr, floatKind, project(e.position)); // bolder than floater()
    styleCharge = Math.min(1, styleCharge + 0.45); // kills keep the style bar alive
    restart(el.cross, "rr-cross--hit");

    // Actions feed line (Quivly voice).
    const label = humanize(e.signal || e.type || e.label) || pickNoun();
    feedRot++;
    if (kind === "boss") pushAction(`Renewal Opportunity — closed-won · +${fmtMoney(arr)}`, "boss");
    else if (fullStack) pushAction(`Full Stack · ${sources} sources · ${label} · +${fmtMoney(arr)}`, "full");
    else pushAction(`Deployed · ${label} resolved · +${fmtMoney(arr)}`, "signal");

    // Champion departure = high-value priority moment.
    const champ = e.champion === true || kind === "champion" || /champion/i.test(String(e.signal || e.type || e.label || ""));
    if (champ) callout(SCRIPT.champion, "gold");

    if (fullStack) {
      fullStackCount += 1;
      if (el.fsCount) el.fsCount.textContent = String(fullStackCount);
      if (el.fsPill) restart(el.fsPill, "rr-pop");
      showFsBadge(sources);
      pushAction(`Draft ready — grounded in ${groundedIn(sources)}`, "muted");
      if (!ahaShown) { ahaShown = true; callout(SCRIPT.aha, "accent"); } // the aha moment
    }
  });

  on("escape", (e = {}) => {
    const sev = Number(e.severity) || 1;
    callout(sev >= 2 ? "ACCOUNT AT RISK" : "SIGNAL ESCAPED", "risk");
    floater("ESCAPED", "miss", centerPt());
    pushAction(sev >= 2 ? "Signal escaped — account slipping" : "Signal escaped — untriaged", "miss");
    shake(sev >= 2 ? "rr-shake--hard" : "rr-shake");
    flashVignette("hit");
  });

  on("hitHealthy", () => {
    callout("FALSE POSITIVE — HOLD FIRE", "warning");
    floater("HEALTHY", "warn", centerPt());
    pushAction("Healthy account hit — false positive", "warn");
    flashVignette("hit");
  });

  on("hurt", (e = {}) => {
    flashVignette("hit", Math.min(0.35, (Number(e.amount) || 8) / 40));
    shake("rr-shake");
  });

  on("combo", (e = {}) => {
    const c = Number(e.combo) || 0;
    if (c >= COMBO_TIERS[2]) callout("UNSTOPPABLE — 5× ARR", "gold");
    else if (c >= COMBO_TIERS[1]) callout("HOT STREAK — 3× ARR", "gold");
    else if (c >= COMBO_TIERS[0]) callout("STREAK — 2× ARR", "accent");
    restart(el.combo, "rr-pop");
  });

  on("pulse", () => restart(el.cross, "rr-cross--pulse"));
  on("fire", () => restart(el.cross, "rr-cross--fire"));

  on("zone", (e = {}) => {
    if (!e?.name || !el.zone) return;
    const key = String(e.name).toLowerCase().replace(/[^a-z]/g, "");
    const sector = SECTORS[key] || Object.values(SECTORS).find((s) => key && s.title.toLowerCase().includes(key));
    if (el.zoneTitle) el.zoneTitle.textContent = sector ? sector.title : `ENTERING · ${String(e.name).toUpperCase()}`;
    if (el.zoneLine) el.zoneLine.textContent = sector ? sector.line : "";
    restart(el.zone, "rr-show");
  });

  on("win", () => endState("won"));
  on("lose", () => endState("lost"));
  on("callout", (e = {}) => callout(e.text, e.kind)); // enemy agent banter ("Stribe's going dark!")
  on("overtime", startOvertime);
  on("act2", startOvertime);
  on("focus", triggerLastStand);
  on("laststand", triggerLastStand);
  on("draft", openDraft);
  on("mutator", (e) => {
    mutatorName = (typeof e === "string" ? e : e?.name || e?.mutator) || null;
    updateMutatorChips();
  });
  on("meta", (e = {}) => {
    if (typeof e.best === "number") { best = Math.max(best, e.best); updateBestChips(); }
    if (e.mutator || e.name) { mutatorName = e.mutator || e.name; updateMutatorChips(); }
  });

  // Optional aim override if a collaborator emits one (purely additive).
  on("aim", (e = {}) => { aim = { kind: e?.kind || null, t: performance.now() }; });

  // Total Overdose juice (combat/controller seam).
  on("style", applyStyle); // {rank,mult,points} on style change
  on("announce", (e = {}) => announce(e.text, e.tone)); // {text,tone} rank-ups / notable kills
  on("dive", () => { if (el.focusWrap) restart(el.focusWrap, "rr-focus--dive"); }); // shootdodge launch

  // ---- per-frame bind ------------------------------------------------------
  function update() {
    if (disposed) return;
    let snap;
    try { snap = game?.snapshot?.(); } catch { snap = null; }
    if (!snap) return;

    const status = snap.status;
    if (status === "running" && !titleShown) reveal();
    else if (status === "running" && startedOnce && !truthy(state?.paused)) reveal();

    // ARR Saved + rank strip.
    if (snap.arr !== cache.arr) {
      cache.arr = snap.arr;
      if (el.arr) el.arr.textContent = fmtMoney(snap.arr);
      const r = rankFor(snap.arr);
      const rankKey = `${r.name}|${r.remaining}`;
      if (rankKey !== cache.rank) {
        cache.rank = rankKey;
        if (el.rankName) el.rankName.textContent = r.name;
        if (el.rankNext) el.rankNext.textContent = r.next ? `Next: ${r.next.name} in ${fmtMoney(r.remaining)}` : "Top rank reached";
        if (el.rankFill) el.rankFill.style.width = `${(r.prog * 100).toFixed(1)}%`;
      }
    }

    // Renewal timer (mm:ss) + thin remaining bar; red under 20s.
    const t = fmtTime(snap.timeLeft);
    if (t !== cache.timer) { cache.timer = t; if (el.timer) el.timer.textContent = t; }
    const urgent = snap.timeLeft <= 20000 && status === "running" && !overtimeActive;
    if (urgent !== cache.urgent) {
      cache.urgent = urgent;
      el.timerWrap?.classList.toggle("rr-timer--urgent", urgent);
    }
    const frac = Math.max(0, Math.min(1, snap.timeLeft / RENEWAL_MS));
    if (Math.abs(frac - cache.timeFrac) > 0.004) {
      cache.timeFrac = frac;
      if (el.timeFill) el.timeFill.style.width = `${(frac * 100).toFixed(1)}%`;
    }

    // Deploys.
    if (snap.deploys !== cache.deploys) {
      cache.deploys = snap.deploys;
      if (el.deploys) el.deploys.textContent = String(snap.deploys);
    }

    // Multiplier.
    if (snap.multiplier !== cache.mult) {
      cache.mult = snap.multiplier;
      if (el.mult) el.mult.textContent = `${snap.multiplier}×`;
      const tier = snap.multiplier >= 5 ? 3 : snap.multiplier >= 3 ? 2 : snap.multiplier > 1 ? 1 : 0;
      if (el.multPill) el.multPill.dataset.tier = String(tier);
    }

    // Customer 360 · Health Score (numeric + bucket color).
    if (snap.health !== cache.health) {
      cache.health = snap.health;
      const hs = Math.round(snap.health);
      if (el.healthScore) el.healthScore.textContent = String(hs);
      if (el.healthFill) el.healthFill.style.width = `${snap.health}%`;
      const bucket = hs < 25 ? "critical" : hs < 50 ? "high" : hs < 75 ? "medium" : "healthy";
      if (el.healthWrap) el.healthWrap.dataset.bucket = bucket;
      if (el.healthBucket) {
        el.healthBucket.textContent =
          bucket === "critical" ? "CRITICAL" : bucket === "high" ? "HIGH RISK" : bucket === "medium" ? "MEDIUM" : "HEALTHY";
      }
    }

    // Health trend arrow (sampled window).
    const now = performance.now();
    if (now - lastTrendPush > 100) {
      lastTrendPush = now;
      trendBuf.push({ t: now, h: snap.health });
      while (trendBuf.length && now - trendBuf[0].t > 3200) trendBuf.shift();
    }
    if (now - lastTrendAt > 320) {
      lastTrendAt = now;
      const oldH = trendBuf.length ? trendBuf[0].h : snap.health;
      const delta = Math.round(snap.health - oldH);
      const dir = delta > 1 ? "up" : delta < -1 ? "down" : "flat";
      const key = `${dir}:${delta}`;
      if (key !== cache.trend && el.healthTrend) {
        cache.trend = key;
        const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "—";
        el.healthTrend.textContent = `${arrow} ${delta > 0 ? "+" : ""}${delta}`;
        el.healthTrend.dataset.dir = dir;
      }
    }

    // Low-health edge vignette (subtle, edge only).
    const low = snap.health < 35 && status === "running";
    if (low !== cache.low) {
      cache.low = low;
      root.classList.toggle("rr-lowhealth", low);
      el.vignette?.classList.toggle("rr-v--danger", low);
    }
    // Last Stand presentation (slow-mo itself is fx's job).
    if (snap.health <= 20 && status === "running") triggerLastStand();

    // Radar · Churn Threat.
    if (snap.threat !== cache.threat) {
      cache.threat = snap.threat;
      if (el.threatFill) el.threatFill.style.width = `${snap.threat}%`;
      if (el.threatVal) el.threatVal.textContent = `${Math.round(snap.threat)}%`;
      el.threatWrap?.classList.toggle("rr-threat--hot", snap.threat >= 70);
    }

    // Combo display (show from 2×; pop on increase).
    if (snap.combo !== cache.combo) {
      const grew = snap.combo > cache.combo && snap.combo >= 2;
      cache.combo = snap.combo;
      if (el.comboNum) el.comboNum.textContent = String(snap.combo);
      const show = snap.combo >= 2 && status === "running";
      el.combo?.classList.toggle("rr-on", show);
      const tier = snap.combo >= COMBO_TIERS[2] ? 3 : snap.combo >= COMBO_TIERS[1] ? 2 : snap.combo >= COMBO_TIERS[0] ? 1 : 0;
      if (el.combo) el.combo.dataset.tier = String(tier);
      if (grew) restart(el.combo, "rr-pop");
    }

    // FOCUS meter (dive readiness) — bound to ctx.state.focus (0..1). Producer is
    // a separate agent, so read defensively; "DIVE READY" = full AND not diving.
    const focus = Math.max(0, Math.min(1, Number(truthy(state?.focus)) || 0));
    const diving = truthy(state?.diving) === true;
    const ready = focus >= 0.999 && !diving;
    if (Math.abs(focus - cache.focus) > 0.01) {
      cache.focus = focus;
      if (el.focusFill) el.focusFill.style.width = `${(focus * 100).toFixed(0)}%`;
    }
    if (ready !== cache.focusReady) {
      cache.focusReady = ready;
      el.focusWrap?.classList.toggle("rr-focus--ready", ready);
      if (el.focusState) el.focusState.textContent = ready ? "DIVE READY" : diving ? "DIVING" : "CHARGING";
    }

    // STYLE points bar — visual recency charge (rank/mult/color held from "style").
    // onFrame here gets no dt (registered as () => update()), so decay via now.
    if (styleCharge > 0) {
      const dms = lastStyleDecayAt ? now - lastStyleDecayAt : 0;
      styleCharge = Math.max(0, styleCharge - (dms / 1000) / 3.4); // ~3.4s to empty
    }
    lastStyleDecayAt = now;
    const sb = Math.round(styleCharge * 100);
    if (sb !== cache.styleBar) {
      cache.styleBar = sb;
      if (el.styleFill) el.styleFill.style.width = `${sb}%`;
    }

    // End state (fallback if win/lose events weren't emitted).
    if (status === "won" || status === "lost") endState(status);

    // Crosshair: visible while live + locked; colour by what it covers.
    const paused = truthy(state?.paused) === true;
    const locked = state && "locked" in state ? truthy(state.locked) === true : true;
    const live = status === "running" && !paused;
    const visible = live && locked;
    let kind = "normal";
    if (visible) {
      const k = aimKind();
      if (k === "healthy") kind = "healthy";
      else if (k === "signal" || k === "elite" || k === "shielded" || k === "churn" || k === "boss") kind = "target";
    }
    const crossKey = `${visible}:${kind}`;
    if (crossKey !== cache.crossKind) {
      cache.crossKind = crossKey;
      el.cross?.classList.toggle("rr-cross--hidden", !visible);
      el.cross?.classList.toggle("rr-cross--target", kind === "target");
      el.cross?.classList.toggle("rr-cross--healthy", kind === "healthy");
    }
  }

  // register the frame loop (store unsub if the harness returns one)
  let frameOff;
  if (typeof onFrame === "function") frameOff = onFrame(() => update());

  // ---- teardown ------------------------------------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;
    // ALWAYS restore a pause we introduced — never freeze the game on teardown.
    if (state && (titlePaused || draftPaused)) state.paused = false;
    titlePaused = draftPaused = false;
    if (typeof frameOff === "function") { try { frameOff(); } catch { /* noop */ } }
    while (offs.length) { try { offs.pop()(); } catch { /* noop */ } }
    while (timers.length) clearTimeout(timers.pop());
    root.remove();
    endLayer.remove();
    // remove the style only if no other HUD instance is alive
    if (!document.querySelector(".rr-hud")) document.getElementById(STYLE_ID)?.remove();
    // if WE created #hud and it's now empty, clean it up too
    if (createdHost && host && host.childElementCount === 0 && host.parentElement) host.remove();
  }

  return { update, dispose };
}

// ---------------------------------------------------------------------------
// DOM templates
// ---------------------------------------------------------------------------
const TEMPLATE = `
  <div class="rr-vignette"></div>

  <header class="rr-top">
    <div class="rr-tl">
      <div class="rr-brand">
        <span class="rr-dot"></span>
        <div class="rr-brand__txt">
          <span class="rr-brand__name">RENEWAL&nbsp;RUSH</span>
          <span class="rr-brand__sub">Customer&nbsp;360 · Quivly Agent Ops</span>
        </div>
      </div>
      <div class="rr-chips">
        <span class="rr-chip rr-chip--best" data-best>Best $0</span>
        <span class="rr-chip rr-chip--mut" data-mutator hidden>Mutator</span>
      </div>
    </div>

    <div class="rr-pills">
      <div class="rr-pill rr-pill--arr">
        <span class="rr-pill__k">ARR Saved</span>
        <strong class="rr-pill__v" data-arr>$0</strong>
      </div>
      <div class="rr-pill rr-pill--mult" data-tier="0">
        <span class="rr-pill__k">Mult</span>
        <strong class="rr-pill__v" data-mult>1×</strong>
      </div>
      <div class="rr-pill rr-pill--fs">
        <span class="rr-pill__k">Full Stack</span>
        <strong class="rr-pill__v" data-fscount>0</strong>
      </div>
      <div class="rr-pill">
        <span class="rr-pill__k">Deploys</span>
        <strong class="rr-pill__v" data-deploys>0</strong>
      </div>
    </div>
  </header>

  <div class="rr-timer">
    <span class="rr-timer__k" data-timerlabel>Renewal Day</span>
    <strong class="rr-timer__v" data-timer>1:30</strong>
    <div class="rr-timer__track"><div class="rr-timer__fill" data-timefill style="width:100%"></div></div>
  </div>

  <div class="rr-banners">
    <div class="rr-zone"><b class="rr-zone__t" data-zonetitle></b><span class="rr-zone__l" data-zoneline></span></div>
    <div class="rr-overtime"><b>OVERTIME · EXPANSION RUN</b><span>Renewal closed-won. Now chase expansion — how long can you last?</span></div>
    <div class="rr-laststand"><b>FOCUS · LAST STAND</b><span>Portfolio critical — land deploys to stabilize.</span></div>
  </div>

  <aside class="rr-actions">
    <div class="rr-actions__k">Actions</div>
    <div class="rr-actions__list"></div>
  </aside>

  <div class="rr-rail">
    <div class="rr-style" data-rank="cool">
      <div class="rr-style__head">
        <span class="rr-style__k">Style</span>
        <b class="rr-style__rank" data-stylerank>COOL</b>
        <span class="rr-style__mult" data-stylemult>×1</span>
      </div>
      <div class="rr-style__track"><div class="rr-style__fill" data-stylefill style="width:0%"></div></div>
    </div>
    <div class="rr-focus">
      <div class="rr-focus__head">
        <span class="rr-focus__k">Focus</span>
        <span class="rr-focus__state" data-focusstate>CHARGING</span>
      </div>
      <div class="rr-focus__track"><div class="rr-focus__fill" data-focusfill style="width:0%"></div></div>
    </div>
  </div>

  <div class="rr-center">
    <div class="rr-announce" data-tone="style"></div>
    <div class="rr-callout" data-kind="accent"></div>
    <div class="rr-fsbadge"><b>FULL STACK</b><span data-fssources>2 sources</span></div>
    <div class="rr-combo" data-tier="0">
      <span class="rr-combo__k">STREAK</span>
      <span class="rr-combo__v">×<b data-combo>0</b></span>
    </div>
    <div class="rr-cross rr-cross--hidden"><span></span></div>
  </div>

  <footer class="rr-bottom">
    <section class="rr-health rr-panel" data-bucket="healthy">
      <div class="rr-panel__head">
        <span class="rr-panel__k">Customer 360 · Health Score</span>
        <span class="rr-health__trend" data-healthtrend data-dir="flat">— 0</span>
      </div>
      <div class="rr-health__body">
        <div class="rr-health__score"><b data-healthscore>100</b><i class="rr-health__bucket" data-healthbucket>HEALTHY</i></div>
        <div class="rr-bar__track rr-bar__track--health">
          <div class="rr-bar__fill rr-health__fill" data-healthfill style="width:100%"></div>
          <div class="rr-bar__mark"></div>
        </div>
      </div>
    </section>

    <div class="rr-rank rr-panel">
      <div class="rr-rank__head"><b class="rr-rank__name" data-rankname>Renewal Rookie</b><span class="rr-rank__next" data-ranknext>Next: Account Defender in $5,000</span></div>
      <div class="rr-rank__track"><div class="rr-rank__fill" data-rankfill style="width:0%"></div></div>
    </div>

    <section class="rr-threat rr-panel">
      <div class="rr-panel__head"><span class="rr-panel__k">Radar · Churn Threat</span><b class="rr-panel__v" data-threatval>0%</b></div>
      <div class="rr-bar__track"><div class="rr-bar__fill rr-threat__fill" data-threatfill style="width:0%"></div></div>
    </section>
  </footer>

  <div class="rr-floaters"></div>

  <div class="rr-title">
    <div class="rr-title__inner">
      <div class="rr-title__badge"><span class="rr-dot"></span> Quivly Agent Ops</div>
      <h1 class="rr-title__name">RENEWAL<br>RUSH</h1>
      <p class="rr-title__tag">Every signal. One place. 90 seconds to renewal day.</p>
      <div class="rr-title__meta">
        <span class="rr-chip rr-chip--best" data-titlebest>Best $0</span>
        <span class="rr-chip rr-chip--mut" data-titlemutator hidden>Mutator</span>
      </div>
      <button type="button" class="rr-title__cta">Deploy agents ▸</button>
      <div class="rr-title__hint">WASD move · Mouse aim · Click / Space deploy · E pulse · Shift dash</div>
      <div class="rr-title__cta2">A game by Quivly — the real thing runs autonomously across your stack · quivly.ai</div>
    </div>
  </div>

  <div class="rr-draft">
    <div class="rr-draft__inner">
      <div class="rr-draft__head"><b>UPGRADE DRAFT</b><span>Pick one — it applies for the rest of the run.</span></div>
      <div class="rr-draft__cards"></div>
    </div>
  </div>
`;

const END_TEMPLATE = `
  <div class="rr-end" data-kind="won">
    <div class="rr-end__line" data-endline></div>
    <div class="rr-end__stats" data-endstats></div>
    <div class="rr-end__cta">${SCRIPT.cta}</div>
  </div>
`;

// ---------------------------------------------------------------------------
// Styles (injected once)
// ---------------------------------------------------------------------------
function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
.rr-hud{
  --accent:${C.accent}; --accent-soft:${C.accentSoft};
  --success:${C.success}; --warning:${C.warning}; --risk:${C.risk}; --gold:${C.gold};
  --glass:linear-gradient(180deg,rgba(20,22,34,.74),rgba(9,10,16,.80));
  --glass-soft:linear-gradient(180deg,rgba(24,26,40,.62),rgba(10,11,18,.70));
  --hair:rgba(110,231,183,.16); --hair2:rgba(255,255,255,.07);
  --ink:#EAF6EF; --mute:rgba(226,229,242,.56);
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"Inter",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  position:fixed; inset:0; z-index:30; pointer-events:none;
  color:var(--ink); font-family:var(--sans);
  opacity:0; transition:opacity .5s ease;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; text-rendering:optimizeLegibility;
}
.rr-hud.rr-active{opacity:1;}
.rr-hud *{box-sizing:border-box;}

/* glass primitives */
.rr-pill,.rr-timer,.rr-panel,.rr-zone,.rr-brand,.rr-chip,.rr-actions,.rr-overtime,.rr-laststand{
  background:var(--glass); border:1px solid var(--hair2); border-radius:13px;
  backdrop-filter:blur(11px) saturate(150%); -webkit-backdrop-filter:blur(11px) saturate(150%);
  box-shadow:0 10px 34px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
}

/* ── top bar ─────────────────────────────────────────────────────────────── */
.rr-top{position:absolute; top:16px; left:18px; right:18px;
  display:flex; justify-content:space-between; align-items:flex-start; gap:12px;}
.rr-tl{display:flex; flex-direction:column; gap:8px; align-items:flex-start;}
.rr-brand{display:flex; align-items:center; gap:9px; padding:8px 13px;}
.rr-brand__txt{display:flex; flex-direction:column; gap:1px; line-height:1;}
.rr-dot{width:8px; height:8px; border-radius:50%; background:var(--accent); flex:none;
  box-shadow:0 0 12px var(--accent),0 0 4px var(--accent); animation:rr-breathe 2.4s ease-in-out infinite;}
.rr-brand__name{font-weight:800; font-size:.74rem; letter-spacing:.15em;}
.rr-brand__sub{font-size:.58rem; color:var(--mute); letter-spacing:.07em;}
@media (max-width:640px){.rr-brand__sub{display:none;}}

.rr-chips{display:flex; gap:6px; flex-wrap:wrap;}
.rr-chip{padding:4px 9px; border-radius:8px; font-family:var(--mono); font-size:.58rem;
  letter-spacing:.04em; color:var(--accent-soft);}
.rr-chip--best{color:var(--gold);}
.rr-chip--mut{color:#f0abfc; border-color:rgba(240,171,252,.28);}
.rr-chip[hidden]{display:none;}

.rr-pills{display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;}
.rr-pill{display:flex; flex-direction:column; gap:2px; padding:7px 13px; min-width:64px;}
.rr-pill__k{font-size:.54rem; letter-spacing:.13em; text-transform:uppercase; color:var(--mute);}
.rr-pill__v{font-family:var(--mono); font-size:1rem; font-weight:700; line-height:1.05; color:var(--ink);
  font-variant-numeric:tabular-nums;}
.rr-pill--arr .rr-pill__v{color:var(--gold); text-shadow:0 0 14px rgba(252,211,77,.45);}
.rr-pill--mult{transition:border-color .25s, box-shadow .25s;}
.rr-pill--mult .rr-pill__v{color:var(--mute);}
.rr-pill--mult[data-tier="1"] .rr-pill__v{color:var(--accent-soft); text-shadow:0 0 12px rgba(43,217,138,.5);}
.rr-pill--mult[data-tier="2"]{border-color:rgba(43,217,138,.5);}
.rr-pill--mult[data-tier="2"] .rr-pill__v{color:#A7F3D0; text-shadow:0 0 14px rgba(43,217,138,.7);}
.rr-pill--mult[data-tier="3"]{border-color:rgba(252,211,77,.55); box-shadow:0 0 18px rgba(252,211,77,.28), inset 0 1px 0 rgba(255,255,255,.06);}
.rr-pill--mult[data-tier="3"] .rr-pill__v{color:var(--gold); text-shadow:0 0 16px rgba(252,211,77,.8); animation:rr-tick 1s ease-in-out infinite;}
.rr-pill--fs .rr-pill__v{color:var(--accent-soft);}
.rr-pill--fs.rr-pop{animation:rr-pop .4s ease;}
.rr-pill--fs.rr-pop .rr-pill__v{color:var(--gold); text-shadow:0 0 16px rgba(252,211,77,.8);}
@media (max-width:640px){.rr-pill--fs,.rr-pill--mult{display:none;}}

/* ── renewal timer (hero) ────────────────────────────────────────────────── */
.rr-timer{position:absolute; top:14px; left:50%; transform:translateX(-50%);
  display:flex; flex-direction:column; align-items:center; gap:3px; padding:8px 24px 10px;
  transition:border-color .25s, box-shadow .25s;}
.rr-timer__k{font-size:.55rem; letter-spacing:.24em; text-transform:uppercase; color:var(--mute);}
.rr-timer__v{font-family:var(--mono); font-size:1.85rem; font-weight:700; line-height:1;
  letter-spacing:.03em; color:var(--ink); font-variant-numeric:tabular-nums;
  text-shadow:0 0 18px rgba(43,217,138,.35);}
.rr-timer__track{width:128px; height:3px; border-radius:3px; background:rgba(255,255,255,.10); overflow:hidden;}
.rr-timer__fill{height:100%; width:100%; border-radius:3px;
  background:linear-gradient(90deg,var(--accent),var(--accent-soft)); transition:width .3s linear;}
.rr-timer--urgent{border-color:rgba(248,113,113,.6); box-shadow:0 0 26px rgba(248,113,113,.42), inset 0 1px 0 rgba(255,255,255,.06); animation:rr-urge .9s ease-in-out infinite;}
.rr-timer--urgent .rr-timer__v{color:var(--risk); text-shadow:0 0 20px rgba(248,113,113,.8);}
.rr-timer--urgent .rr-timer__fill{background:linear-gradient(90deg,var(--risk),#fca5a5);}
@media (max-width:640px){.rr-timer__v{font-size:1.45rem;} .rr-timer{padding:6px 16px 8px;}}

/* ── banners (zone / overtime / last stand) ─────────────────────────────── */
.rr-banners{position:absolute; top:92px; left:0; right:0; display:flex; flex-direction:column;
  align-items:center; gap:8px; pointer-events:none;}
.rr-zone{display:flex; flex-direction:column; align-items:center; gap:2px; padding:7px 18px 8px;
  max-width:min(86vw,560px); text-align:center; opacity:0; transform:translateY(-6px);}
.rr-zone__t{font-family:var(--mono); font-size:.66rem; letter-spacing:.16em; color:var(--accent-soft);}
.rr-zone__l{font-size:.66rem; color:var(--mute); letter-spacing:.01em; line-height:1.35;}
.rr-zone.rr-show{animation:rr-toast 4.6s ease forwards;}
.rr-overtime,.rr-laststand{display:flex; flex-direction:column; align-items:center; gap:1px;
  padding:8px 22px; text-align:center; opacity:0; transform:translateY(-6px);}
.rr-overtime b{font-weight:800; font-size:.92rem; letter-spacing:.14em; color:var(--accent-soft);
  text-shadow:0 0 18px rgba(43,217,138,.55);}
.rr-overtime span{font-size:.6rem; color:var(--mute);}
.rr-overtime{border-color:rgba(43,217,138,.45);}
.rr-overtime.rr-show{animation:rr-banner 4.2s cubic-bezier(.2,.8,.2,1) forwards;}
.rr-laststand{border-color:rgba(252,211,77,.45);}
.rr-laststand b{font-weight:800; font-size:.92rem; letter-spacing:.14em; color:var(--gold);
  text-shadow:0 0 18px rgba(252,211,77,.6);}
.rr-laststand span{font-size:.6rem; color:var(--mute);}
.rr-laststand.rr-show{animation:rr-banner 3.4s cubic-bezier(.2,.8,.2,1) forwards;}

/* ── actions feed ────────────────────────────────────────────────────────── */
.rr-actions{position:absolute; top:108px; right:18px; width:min(28vw,272px); padding:9px 11px 7px;
  display:flex; flex-direction:column; gap:5px; background:var(--glass-soft);}
.rr-actions__k{font-size:.52rem; letter-spacing:.18em; text-transform:uppercase; color:var(--mute);}
.rr-actions__list{display:flex; flex-direction:column; gap:4px;}
.rr-act{font-family:var(--mono); font-size:.62rem; line-height:1.3; color:var(--ink);
  padding:4px 8px; border-radius:7px; border-left:2px solid var(--accent);
  background:rgba(43,217,138,.10); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  animation:rr-actin .3s ease; transition:opacity .4s ease, transform .4s ease;}
.rr-act--out{opacity:0; transform:translateX(14px);}
.rr-act--full{border-left-color:var(--gold); background:rgba(252,211,77,.12); color:var(--gold);}
.rr-act--boss{border-left-color:#e879f9; background:rgba(232,121,249,.12); color:#f0abfc;}
.rr-act--miss{border-left-color:var(--risk); background:rgba(248,113,113,.12); color:#fecaca;}
.rr-act--warn{border-left-color:var(--warning); background:rgba(251,191,36,.12); color:#fde68a;}
.rr-act--muted{border-left-color:var(--hair); background:rgba(255,255,255,.05); color:var(--mute);}
@media (max-width:760px){.rr-actions{display:none;}}

/* ── centre stack ────────────────────────────────────────────────────────── */
.rr-center{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;}
.rr-callout{position:absolute; top:23%; font-weight:800; font-size:1.45rem; letter-spacing:.02em;
  text-align:center; opacity:0; text-shadow:0 4px 24px rgba(0,0,0,.7); max-width:min(86vw,720px); line-height:1.25;}
.rr-callout[data-kind="accent"]{color:var(--accent-soft);}
.rr-callout[data-kind="success"]{color:var(--success);}
.rr-callout[data-kind="warning"]{color:var(--warning);}
.rr-callout[data-kind="risk"]{color:var(--risk);}
.rr-callout[data-kind="gold"]{color:var(--gold);}
.rr-callout.rr-show{animation:rr-callout 1.9s cubic-bezier(.2,.8,.2,1) forwards;}
@media (max-width:640px){.rr-callout{font-size:1.05rem; top:21%;}}

.rr-fsbadge{position:absolute; top:30%; display:flex; flex-direction:column; align-items:center; gap:1px;
  opacity:0; pointer-events:none;}
.rr-fsbadge b{font-weight:800; font-size:1.15rem; letter-spacing:.22em; color:var(--gold);
  text-shadow:0 0 22px rgba(252,211,77,.85);}
.rr-fsbadge span{font-family:var(--mono); font-size:.6rem; color:var(--accent-soft); letter-spacing:.1em;}
.rr-fsbadge.rr-show{animation:rr-fsbadge 1.1s cubic-bezier(.2,.8,.2,1) forwards;}

.rr-combo{position:absolute; top:35%; display:flex; flex-direction:column; align-items:center; gap:1px;
  opacity:0; transform:scale(.8); transition:opacity .18s ease, transform .18s ease; pointer-events:none;}
.rr-combo.rr-on{opacity:1; transform:scale(1);}
.rr-combo__k{font-size:.54rem; letter-spacing:.3em; color:var(--mute);}
.rr-combo__v{font-family:var(--mono); font-weight:800; font-size:1.7rem; line-height:1; color:var(--accent-soft);
  font-variant-numeric:tabular-nums; text-shadow:0 0 18px rgba(43,217,138,.6);}
.rr-combo[data-tier="2"] .rr-combo__v{color:#A7F3D0;}
.rr-combo[data-tier="3"] .rr-combo__v{color:var(--gold); text-shadow:0 0 22px rgba(252,211,77,.8);}
.rr-combo.rr-pop{animation:rr-combopop .34s ease;}

/* crosshair — three states */
.rr-cross{position:relative; width:26px; height:26px; transition:transform .12s ease;}
.rr-cross::before,.rr-cross::after{content:""; position:absolute; background:var(--accent);
  border-radius:2px; box-shadow:0 0 8px rgba(43,217,138,.8); transition:background .1s, box-shadow .1s;}
.rr-cross::before{left:50%; top:0; width:2px; height:10px; transform:translateX(-50%);}
.rr-cross::after{top:50%; left:0; height:2px; width:10px; transform:translateY(-50%);}
.rr-cross>span{position:absolute; inset:50% auto auto 50%; width:3px; height:3px; margin:-1.5px 0 0 -1.5px;
  border-radius:50%; background:var(--accent); box-shadow:0 0 8px var(--accent); transition:background .1s, box-shadow .1s, transform .12s;}
.rr-cross--hidden{opacity:0;}
.rr-cross--target{transform:scale(1.18) rotate(45deg);}
.rr-cross--target::before,.rr-cross--target::after{background:var(--risk); box-shadow:0 0 12px rgba(248,113,113,.95);}
.rr-cross--target>span{background:var(--risk); box-shadow:0 0 12px var(--risk); transform:scale(1.6);}
.rr-cross--healthy::before,.rr-cross--healthy::after{background:var(--warning); box-shadow:0 0 12px rgba(251,191,36,.9);}
.rr-cross--healthy>span{background:var(--warning); box-shadow:0 0 10px var(--warning);}
.rr-cross--hit{animation:rr-crosshit .18s ease;}
.rr-cross--fire{animation:rr-crossfire .12s ease;}
.rr-cross--pulse{animation:rr-crosspulse .4s ease;}

/* ── bottom panels ───────────────────────────────────────────────────────── */
.rr-bottom{position:absolute; bottom:16px; left:18px; right:18px;
  display:flex; justify-content:space-between; align-items:flex-end; gap:14px;}
.rr-panel{padding:9px 13px 11px;}
.rr-panel__head{display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:7px;}
.rr-panel__k{font-size:.55rem; letter-spacing:.13em; text-transform:uppercase; color:var(--mute);}
.rr-panel__v{font-family:var(--mono); font-size:.82rem; font-weight:700; font-variant-numeric:tabular-nums;}

.rr-bar__track{position:relative; height:8px; border-radius:6px; background:rgba(255,255,255,.10); overflow:hidden;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5);}
.rr-bar__track--health{overflow:visible;}
.rr-bar__fill{height:100%; border-radius:6px; transition:width .35s ease, background .35s ease;}
.rr-bar__mark{position:absolute; top:-2px; bottom:-2px; width:2px; border-radius:2px;
  background:rgba(255,255,255,.55); box-shadow:0 0 6px rgba(255,255,255,.5);}
.rr-bar__mark::after{content:attr(data-label); position:absolute; top:-13px; left:50%; transform:translateX(-50%);
  font-family:var(--mono); font-size:.46rem; color:var(--mute); letter-spacing:.05em;}

/* Customer 360 health */
.rr-health{width:min(34vw,330px);}
.rr-health__body{display:flex; align-items:center; gap:12px;}
.rr-health__score{display:flex; align-items:baseline; gap:7px; flex:none;}
.rr-health__score b{font-family:var(--mono); font-weight:800; font-size:1.7rem; line-height:1;
  font-variant-numeric:tabular-nums;}
.rr-health__bucket{font-style:normal; font-size:.52rem; letter-spacing:.1em; font-weight:700;}
.rr-bar__track--health{flex:1; align-self:center;}
.rr-health__trend{font-family:var(--mono); font-size:.74rem; font-weight:700; font-variant-numeric:tabular-nums;}
.rr-health__trend[data-dir="up"]{color:var(--success);}
.rr-health__trend[data-dir="down"]{color:var(--risk);}
.rr-health__trend[data-dir="flat"]{color:var(--mute);}
.rr-health[data-bucket="healthy"] .rr-health__score b,.rr-health[data-bucket="healthy"] .rr-health__bucket{color:var(--success);}
.rr-health[data-bucket="healthy"] .rr-health__fill{background:linear-gradient(90deg,#10b981,var(--success)); box-shadow:0 0 12px rgba(52,211,153,.5);}
.rr-health[data-bucket="medium"] .rr-health__score b,.rr-health[data-bucket="medium"] .rr-health__bucket{color:var(--warning);}
.rr-health[data-bucket="medium"] .rr-health__fill{background:linear-gradient(90deg,#d97706,var(--warning)); box-shadow:0 0 12px rgba(251,191,36,.5);}
.rr-health[data-bucket="high"] .rr-health__score b,.rr-health[data-bucket="high"] .rr-health__bucket{color:#fb923c;}
.rr-health[data-bucket="high"] .rr-health__fill{background:linear-gradient(90deg,#ea580c,#fb923c); box-shadow:0 0 13px rgba(251,146,60,.6);}
.rr-health[data-bucket="critical"] .rr-health__score b,.rr-health[data-bucket="critical"] .rr-health__bucket{color:var(--risk);}
.rr-health[data-bucket="critical"] .rr-health__fill{background:linear-gradient(90deg,#b91c1c,var(--risk)); box-shadow:0 0 14px rgba(248,113,113,.7);}
.rr-health[data-bucket="critical"]{animation:rr-urge 1s ease-in-out infinite;}

/* rank strip */
.rr-rank{width:min(24vw,240px); align-self:flex-end;}
.rr-rank__head{display:flex; flex-direction:column; gap:1px; margin-bottom:6px; text-align:center;}
.rr-rank__name{font-size:.74rem; font-weight:800; letter-spacing:.04em; color:var(--accent-soft);}
.rr-rank__next{font-family:var(--mono); font-size:.54rem; color:var(--mute);}
.rr-rank__track{height:5px; border-radius:4px; background:rgba(255,255,255,.10); overflow:hidden;}
.rr-rank__fill{height:100%; border-radius:4px; width:0%;
  background:linear-gradient(90deg,var(--accent),var(--gold)); transition:width .4s ease; box-shadow:0 0 10px rgba(43,217,138,.5);}
@media (max-width:760px){.rr-rank{display:none;}}

/* Radar threat */
.rr-threat{width:min(34vw,330px);}
.rr-threat__fill{background:linear-gradient(90deg,var(--accent),var(--risk)); box-shadow:0 0 12px rgba(43,217,138,.4);}
.rr-threat .rr-panel__v{color:var(--accent-soft);}
.rr-threat--hot{border-color:rgba(248,113,113,.45);}
.rr-threat--hot .rr-panel__v{color:var(--risk);}
.rr-threat--hot .rr-threat__fill{animation:rr-tick .8s ease-in-out infinite;}
@media (max-width:640px){.rr-health,.rr-threat{width:46vw; padding:7px 10px 9px;} .rr-health__score b{font-size:1.3rem;}}

/* ── vignette (edge only, subtle) ────────────────────────────────────────── */
.rr-vignette{position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity .4s ease;
  --hit:.7; background:radial-gradient(ellipse at center,transparent 48%,rgba(248,113,113,.13) 100%);}
.rr-vignette.rr-v--danger{opacity:1; animation:rr-vpulse 1.6s ease-in-out infinite;}
.rr-vignette.rr-v--hit{opacity:1;
  background:radial-gradient(ellipse at center,transparent 40%,rgba(248,113,113,calc(.22 + var(--hit)*.3)) 100%);
  animation:rr-vhit .36s ease;}

/* ── floaters ────────────────────────────────────────────────────────────── */
.rr-floaters{position:absolute; inset:0; pointer-events:none; overflow:hidden;}
.rr-float{position:absolute; transform:translate(-50%,-50%); --dx:0px;
  font-family:var(--mono); font-weight:800; font-size:1rem; white-space:nowrap;
  text-shadow:0 2px 12px rgba(0,0,0,.8); animation:rr-floatup 1.5s cubic-bezier(.1,.7,.2,1) forwards;}
.rr-float--signal{color:var(--accent-soft);}
.rr-float--full{color:var(--gold); font-size:1.18rem;}
.rr-float--boss{color:#f0abfc; font-size:1.32rem;}
.rr-float--miss,.rr-float--warn{font-size:.78rem;}
.rr-float--miss{color:var(--risk);}
.rr-float--warn{color:var(--warning);}

/* ── big +ARR kill popups (bolder variant of floaters) ───────────────────── */
.rr-kill{position:absolute; transform:translate(-50%,-50%); --dx:0px; --pk:1;
  font-family:var(--mono); font-weight:800; font-size:1.25rem; white-space:nowrap; letter-spacing:.01em;
  text-shadow:0 2px 16px rgba(0,0,0,.85); pointer-events:none;
  animation:rr-killpop 1.7s cubic-bezier(.1,.7,.2,1) forwards;}
.rr-kill--signal{color:var(--gold);}
.rr-kill--full{color:#fde68a; text-shadow:0 0 20px rgba(252,211,77,.85),0 2px 16px rgba(0,0,0,.85);}
.rr-kill--boss{color:#f0abfc; text-shadow:0 0 24px rgba(232,121,249,.9),0 2px 16px rgba(0,0,0,.85);}

/* ── focus + style rail (Total Overdose) ─────────────────────────────────── */
.rr-rail{position:absolute; left:18px; top:50%; transform:translateY(-50%);
  display:flex; flex-direction:column; gap:10px; width:min(20vw,208px); pointer-events:none;}
@media (max-width:760px){.rr-rail{width:150px;}}
@media (max-width:520px){.rr-rail{display:none;}}
.rr-style,.rr-focus{background:var(--glass); border:1px solid var(--hair2); border-radius:13px;
  padding:9px 12px 11px; backdrop-filter:blur(11px) saturate(150%); -webkit-backdrop-filter:blur(11px) saturate(150%);
  box-shadow:0 10px 34px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);}

/* style meter — Cool→Hot→Loco→OVERDOSE color ramp */
.rr-style{--sc:#38bdf8; transition:border-color .3s ease, box-shadow .3s ease;
  border-color:color-mix(in srgb,var(--sc) 38%, transparent);}
.rr-style__head{display:flex; align-items:baseline; gap:7px; margin-bottom:7px;}
.rr-style__k{font-size:.5rem; letter-spacing:.22em; text-transform:uppercase; color:var(--mute); flex:none;}
.rr-style__rank{flex:1; font-weight:800; font-size:.96rem; letter-spacing:.08em; color:var(--sc); line-height:1;
  display:inline-block; transform-origin:left center;
  text-shadow:0 0 16px color-mix(in srgb,var(--sc) 70%, transparent);}
.rr-style__mult{font-family:var(--mono); font-size:.76rem; font-weight:700; color:var(--sc);
  font-variant-numeric:tabular-nums; flex:none;}
.rr-style__track{height:7px; border-radius:5px; background:rgba(255,255,255,.10); overflow:hidden;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5);}
.rr-style__fill{height:100%; width:0%; border-radius:5px; transition:width .12s linear;
  background:linear-gradient(90deg,var(--sc),#fff); box-shadow:0 0 12px color-mix(in srgb,var(--sc) 70%, transparent);}
.rr-style[data-rank="cool"]{--sc:#38bdf8;}
.rr-style[data-rank="hot"]{--sc:#fb923c;}
.rr-style[data-rank="loco"]{--sc:#e879f9;}
.rr-style[data-rank="overdose"]{--sc:#ffffff;}
.rr-style--pop .rr-style__rank{animation:rr-stylepop .42s cubic-bezier(.2,.8,.2,1);}
.rr-style--overdose{border-color:rgba(255,255,255,.6); animation:rr-overdose 1s ease-in-out infinite;}
.rr-style--overdose .rr-style__rank{
  background:linear-gradient(90deg,#fff,#fde68a,#f0abfc,#fff); -webkit-background-clip:text; background-clip:text;
  -webkit-text-fill-color:transparent; text-shadow:none;}

/* focus meter — dive readiness */
.rr-focus{transition:border-color .3s ease, box-shadow .3s ease;}
.rr-focus__head{display:flex; justify-content:space-between; align-items:baseline; gap:7px; margin-bottom:7px;}
.rr-focus__k{font-size:.5rem; letter-spacing:.22em; text-transform:uppercase; color:var(--mute);}
.rr-focus__state{font-family:var(--mono); font-size:.52rem; letter-spacing:.1em; color:var(--mute);}
.rr-focus__track{height:7px; border-radius:5px; background:rgba(255,255,255,.10); overflow:hidden;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5);}
.rr-focus__fill{height:100%; width:0%; border-radius:5px; transition:width .18s ease;
  background:linear-gradient(90deg,var(--accent),#67e8f9); box-shadow:0 0 12px rgba(43,217,138,.5);}
.rr-focus--ready{border-color:rgba(103,232,249,.6);
  box-shadow:0 0 26px rgba(103,232,249,.45), inset 0 1px 0 rgba(255,255,255,.06); animation:rr-tick .8s ease-in-out infinite;}
.rr-focus--ready .rr-focus__state{color:#a5f3fc; text-shadow:0 0 10px rgba(103,232,249,.7);}
.rr-focus--ready .rr-focus__fill{background:linear-gradient(90deg,#22d3ee,#a5f3fc); box-shadow:0 0 16px rgba(103,232,249,.7);}
.rr-focus--dive{animation:rr-focusdive .5s ease;}

/* ── announcer line (big, distinct from the small callout) ───────────────── */
.rr-announce{position:absolute; top:41%; left:50%; transform:translate(-50%,-50%);
  font-weight:900; font-size:clamp(1.6rem,4.4vw,2.9rem); letter-spacing:.04em; text-transform:uppercase;
  text-align:center; line-height:1.04; opacity:0; max-width:92vw; color:#e2e5f2; pointer-events:none;
  text-shadow:0 4px 24px rgba(0,0,0,.8);}
.rr-announce[data-tone="focus"]{color:#6EE7B7; text-shadow:0 0 28px rgba(43,217,138,.8),0 4px 24px rgba(0,0,0,.8);}
.rr-announce[data-tone="style"]{color:#f0abfc; text-shadow:0 0 30px rgba(232,121,249,.85),0 4px 24px rgba(0,0,0,.8);}
.rr-announce[data-tone="risk"]{color:#fca5a5; text-shadow:0 0 28px rgba(248,113,113,.85),0 4px 24px rgba(0,0,0,.8);}
.rr-announce[data-tone="win"]{color:#86efac; text-shadow:0 0 28px rgba(52,211,153,.85),0 4px 24px rgba(0,0,0,.8);}
.rr-announce.rr-show{animation:rr-announce 1.7s cubic-bezier(.2,.85,.2,1) forwards;}
@media (max-width:640px){.rr-announce{top:38%;}}

/* ── end-state ambient tint ──────────────────────────────────────────────── */
.rr-hud.rr-over .rr-cross,.rr-hud.rr-over .rr-combo,.rr-hud.rr-over .rr-actions{opacity:0;}
.rr-hud.rr-won{filter:saturate(1.05);}
.rr-hud.rr-lost{filter:grayscale(.22) brightness(.93);}

/* ── shakes ──────────────────────────────────────────────────────────────── */
.rr-shake{animation:rr-shake .3s ease;}
.rr-shake--hard{animation:rr-shakehard .42s ease;}

/* ── title screen ────────────────────────────────────────────────────────── */
.rr-title{position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center;
  padding:24px; opacity:0; pointer-events:none; transition:opacity .4s ease;
  background:radial-gradient(1000px 700px at 50% 30%,rgba(43,217,138,.20),rgba(11,51,34,.55) 46%,rgba(4,11,8,.93)),rgba(4,11,8,.90);
  backdrop-filter:blur(7px); -webkit-backdrop-filter:blur(7px);}
.rr-title.rr-show{opacity:1; pointer-events:auto;}
.rr-title__inner{display:flex; flex-direction:column; align-items:center; gap:6px; text-align:center;
  max-width:min(92vw,560px); transform:translateY(12px); transition:transform .5s cubic-bezier(.16,1,.3,1);}
.rr-title.rr-show .rr-title__inner{transform:none;}
.rr-title__badge{display:inline-flex; align-items:center; gap:7px; font-family:var(--mono); font-size:.6rem;
  letter-spacing:.2em; color:var(--accent-soft); padding:5px 13px; border:1px solid rgba(43,217,138,.32);
  border-radius:999px; background:rgba(17,67,46,.45); margin-bottom:4px;}
.rr-title__name{font-weight:900; font-size:clamp(3.4rem,14vw,6.2rem); letter-spacing:.005em; line-height:.84;
  text-transform:uppercase; margin:2px 0 4px;
  background:linear-gradient(168deg,#EAF6EF 0%,#6EE7B7 28%,#2BD98A 60%,#11432E 128%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
  filter:drop-shadow(0 0 44px rgba(43,217,138,.50)) drop-shadow(0 4px 20px rgba(11,51,34,.75));}
.rr-title__tag{font-size:.92rem; color:var(--ink); font-weight:600; line-height:1.4; letter-spacing:.01em;
  max-width:30ch; margin:0 0 2px;}
.rr-title__meta{display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin:6px 0 2px;}
.rr-title__cta{pointer-events:auto; cursor:pointer; margin-top:8px; padding:14px 36px; border:none; border-radius:13px;
  font-family:var(--sans); font-weight:900; font-size:1rem; letter-spacing:.05em; text-transform:uppercase; color:#06241A;
  background:linear-gradient(180deg,#7CECBE 0%,#2BD98A 62%,#1FB877 100%);
  box-shadow:0 14px 34px -8px rgba(43,217,138,.65), 0 0 0 1px rgba(110,231,183,.45) inset, 0 1px 0 rgba(255,255,255,.4) inset;
  transition:transform .14s ease, box-shadow .14s ease, filter .14s ease;}
.rr-title__cta:hover{transform:translateY(-2px); filter:brightness(1.05);
  box-shadow:0 20px 42px -8px rgba(43,217,138,.8), 0 0 0 1px rgba(110,231,183,.6) inset, 0 1px 0 rgba(255,255,255,.5) inset;}
.rr-title__cta:active{transform:translateY(0);}
.rr-title__hint{font-family:var(--mono); font-size:.58rem; color:var(--mute); letter-spacing:.04em; margin-top:10px;}
.rr-title__cta2{font-size:.56rem; color:var(--mute); line-height:1.4; max-width:460px; margin-top:6px;
  letter-spacing:.02em; opacity:.78;}

/* ── upgrade draft ───────────────────────────────────────────────────────── */
.rr-draft{position:absolute; inset:0; z-index:6; display:flex; align-items:center; justify-content:center;
  padding:24px; opacity:0; pointer-events:none; transition:opacity .35s ease;
  background:radial-gradient(900px 600px at 50% 40%,rgba(43,217,138,.16),rgba(6,7,12,.9)),rgba(6,7,12,.86);
  backdrop-filter:blur(7px); -webkit-backdrop-filter:blur(7px);}
.rr-draft.rr-show{opacity:1; pointer-events:auto;}
.rr-draft__inner{display:flex; flex-direction:column; align-items:center; gap:16px; max-width:min(94vw,820px); width:100%;}
.rr-draft__head{display:flex; flex-direction:column; align-items:center; gap:3px; text-align:center;}
.rr-draft__head b{font-weight:800; font-size:1.2rem; letter-spacing:.14em; color:var(--ink);}
.rr-draft__head span{font-size:.72rem; color:var(--mute);}
.rr-draft__cards{display:grid; grid-template-columns:repeat(3,1fr); gap:14px; width:100%;}
@media (max-width:640px){.rr-draft__cards{grid-template-columns:1fr;}}
.rr-card{position:relative; overflow:hidden; --cc:var(--accent-soft);
  pointer-events:auto; cursor:pointer; display:flex; flex-direction:column; align-items:flex-start; gap:8px;
  text-align:left; padding:18px 16px; border:1px solid var(--hair); border-radius:16px; color:var(--ink);
  background:var(--glass); backdrop-filter:blur(11px) saturate(150%); -webkit-backdrop-filter:blur(11px) saturate(150%);
  box-shadow:0 14px 40px -12px rgba(0,0,0,.7); transition:transform .15s ease, border-color .15s ease, box-shadow .15s ease;}
/* per-option accent: instantly distinguishable upgrade choices. idx-cycled (data-independent). */
.rr-card::before{content:""; position:absolute; inset:0 0 auto 0; height:3px;
  background:linear-gradient(90deg,transparent,var(--cc),transparent); opacity:.85;}
.rr-card--0{--cc:#2BD98A;} .rr-card--1{--cc:#67E8F9;} .rr-card--2{--cc:#FCD34D;}
.rr-card:hover{transform:translateY(-3px); border-color:color-mix(in srgb,var(--cc) 60%,transparent);
  box-shadow:0 22px 50px -14px color-mix(in srgb,var(--cc) 50%,transparent), 0 0 0 1px color-mix(in srgb,var(--cc) 30%,transparent) inset;}
.rr-card__glyph{font-size:1.6rem; line-height:1; color:var(--cc); text-shadow:0 0 16px color-mix(in srgb,var(--cc) 60%,transparent);}
.rr-card__tag{font-family:var(--mono); font-size:.54rem; letter-spacing:.12em; text-transform:uppercase; color:var(--mute);}
.rr-card__name{font-weight:800; font-size:1.05rem; letter-spacing:.01em;}
.rr-card__desc{font-size:.72rem; color:var(--mute); line-height:1.4; flex:1;}
.rr-card__pick{font-family:var(--mono); font-size:.62rem; color:var(--cc); letter-spacing:.06em;}

/* ── end cinematic (separate body layer, ABOVE brand.js, never blocking) ──── */
.rr-endlayer{position:fixed; inset:0; z-index:2147483600; pointer-events:none;
  font-family:"Inter",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;}
.rr-end{position:absolute; top:7%; left:50%; transform:translateX(-50%) translateY(-8px);
  display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center;
  max-width:min(90vw,760px); padding:0 18px; opacity:0;}
.rr-end.rr-show{animation:rr-endin 7.2s cubic-bezier(.16,1,.3,1) forwards;}
.rr-end__line{font-weight:800; font-size:clamp(1.05rem,2.6vw,1.5rem); line-height:1.3;
  text-shadow:0 4px 30px rgba(0,0,0,.85);}
.rr-end[data-kind="won"] .rr-end__line{color:#a7f3d0; text-shadow:0 0 30px rgba(52,211,153,.5),0 4px 30px rgba(0,0,0,.85);}
.rr-end[data-kind="lost"] .rr-end__line{color:#fecaca; text-shadow:0 0 30px rgba(248,113,113,.45),0 4px 30px rgba(0,0,0,.85);}
.rr-end__stats{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; font-size:.74rem; color:#e2e5f2;
  letter-spacing:.02em; font-variant-numeric:tabular-nums;}
.rr-end__cta{font-size:.66rem; color:rgba(226,229,242,.7); line-height:1.4; max-width:520px;}

/* ── keyframes ───────────────────────────────────────────────────────────── */
@keyframes rr-breathe{0%,100%{opacity:1;}50%{opacity:.4;}}
@keyframes rr-tick{0%,100%{opacity:1;}50%{opacity:.55;}}
@keyframes rr-pop{0%{transform:scale(1);}45%{transform:scale(1.12);}100%{transform:scale(1);}}
@keyframes rr-urge{0%,100%{box-shadow:0 0 22px rgba(248,113,113,.35), inset 0 1px 0 rgba(255,255,255,.06);}50%{box-shadow:0 0 34px rgba(248,113,113,.65), inset 0 1px 0 rgba(255,255,255,.06);}}
@keyframes rr-callout{0%{opacity:0; transform:translateY(10px) scale(.92);}12%{opacity:1; transform:translateY(0) scale(1.03);}20%{transform:scale(1);}86%{opacity:1;}100%{opacity:0; transform:translateY(-12px) scale(.98);}}
@keyframes rr-fsbadge{0%{opacity:0; transform:scale(.6);}20%{opacity:1; transform:scale(1.12);}34%{transform:scale(1);}74%{opacity:1;}100%{opacity:0; transform:scale(1.04) translateY(-10px);}}
@keyframes rr-combopop{0%{transform:scale(.75);}55%{transform:scale(1.22);}100%{transform:scale(1);}}
@keyframes rr-crosshit{0%{transform:scale(1.5);}100%{transform:scale(1);}}
@keyframes rr-crossfire{0%{transform:scale(.8);}100%{transform:scale(1);}}
@keyframes rr-crosspulse{0%{transform:scale(.6); opacity:.4;}100%{transform:scale(1); opacity:1;}}
@keyframes rr-actin{0%{opacity:0; transform:translateX(14px);}100%{opacity:1; transform:translateX(0);}}
@keyframes rr-floatup{0%{opacity:0; transform:translate(calc(-50% + 0px),-50%) scale(.8);}14%{opacity:1; transform:translate(calc(-50% + calc(var(--dx)*.3)),-66%) scale(1.08);}100%{opacity:0; transform:translate(calc(-50% + var(--dx)),-140%) scale(1);}}
@keyframes rr-toast{0%{opacity:0; transform:translateY(-6px);}7%{opacity:1; transform:translateY(0);}88%{opacity:1;}100%{opacity:0; transform:translateY(-6px);}}
@keyframes rr-banner{0%{opacity:0; transform:translateY(-6px) scale(.96);}10%{opacity:1; transform:translateY(0) scale(1);}84%{opacity:1;}100%{opacity:0; transform:translateY(-6px) scale(.98);}}
@keyframes rr-endin{0%{opacity:0; transform:translateX(-50%) translateY(-8px);}6%{opacity:1; transform:translateX(-50%) translateY(0);}86%{opacity:1;}100%{opacity:0; transform:translateX(-50%) translateY(-10px);}}
@keyframes rr-vpulse{0%,100%{opacity:.7;}50%{opacity:1;}}
@keyframes rr-killpop{
  0%{opacity:0; transform:translate(-50%,-50%) scale(calc(var(--pk)*.5));}
  16%{opacity:1; transform:translate(calc(-50% + calc(var(--dx)*.3)),-72%) scale(calc(var(--pk)*1.15));}
  30%{transform:translate(calc(-50% + calc(var(--dx)*.5)),-86%) scale(var(--pk));}
  100%{opacity:0; transform:translate(calc(-50% + var(--dx)),-162%) scale(calc(var(--pk)*.92));}}
@keyframes rr-stylepop{0%{transform:scale(1);}30%{transform:scale(1.18);}60%{transform:scale(.97);}100%{transform:scale(1);}}
@keyframes rr-overdose{
  0%,100%{box-shadow:0 0 26px rgba(255,255,255,.35),0 0 54px rgba(232,121,249,.3), inset 0 1px 0 rgba(255,255,255,.12);}
  50%{box-shadow:0 0 42px rgba(255,255,255,.6),0 0 84px rgba(252,211,77,.5), inset 0 1px 0 rgba(255,255,255,.18);}}
@keyframes rr-focusdive{0%{transform:scale(1);}40%{transform:scale(1.05);}100%{transform:scale(1);}}
@keyframes rr-announce{
  0%{opacity:0; transform:translate(-50%,-50%) scale(.7);}
  14%{opacity:1; transform:translate(-50%,-50%) scale(1.14);}
  24%{transform:translate(-50%,-50%) scale(1);}
  80%{opacity:1; transform:translate(-50%,-50%) scale(1);}
  100%{opacity:0; transform:translate(-50%,-58%) scale(1.02);}}
@keyframes rr-vhit{0%{opacity:1;}100%{opacity:0;}}
@keyframes rr-shake{10%{transform:translate(-2px,1px);}30%{transform:translate(3px,-2px);}50%{transform:translate(-3px,2px);}70%{transform:translate(2px,-1px);}90%{transform:translate(-1px,1px);}}
@keyframes rr-shakehard{10%{transform:translate(-5px,2px) rotate(-.3deg);}30%{transform:translate(6px,-3px) rotate(.3deg);}50%{transform:translate(-6px,3px) rotate(-.2deg);}70%{transform:translate(4px,-2px);}90%{transform:translate(-2px,1px);}}

@media (prefers-reduced-motion:reduce){
  .rr-hud *,.rr-endlayer *{animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.05ms !important;}
}
`;
