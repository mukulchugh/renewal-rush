// brand.js — Phase 5 visual storytelling + marketing for Renewal Rush.
//
// Two jobs (Quivly-true, sharp HD):
//   1) makeSignalCard(scene, source, riskTier, opts) — turns each enemy into a crisp,
//      READABLE branded "signal card": a high-res DynamicTexture (640×800) showing the
//      source (CRM/Gong/Stripe/Zendesk/Slack/Market) + glyph, a RISK badge colored by
//      score bucket (low→critical), the account, ARR, sentiment (1–5), and source chips
//      (Full-Stack moat flag for multi-source). Premium dark-glass, indigo accent,
//      emissive tier edge so it pops under the GlowLayer. Returns the plane mesh; the
//      caller (enemies.js) owns mesh.metadata — we only stamp a non-conflicting handle.
//   2) showResult(result) — on bus "win"/"lose" (or called directly), renders a sharp
//      HD shareable RESULT CARD (ARR saved, named rank, deploys, best combo, health)
//      in Quivly's voice (script beats from QUIVLY-GROUNDING.md), with share / copy /
//      download actions and a "Book a demo → quivly.ai" CTA linking https://app.quivly.ai.
//
// Contract: one factory export `createBrand(ctx)` returning { makeSignalCard, showResult,
// dispose, ... }. Deep ESM imports only (tree-shakeable). No top-level side effects.

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

// ── Brand palette ─────────────────────────────────────────────────────────────
const C = {
  indigo: "#6366F1",
  indigoSoft: "#a5b4fc",
  indigoDeep: "#4F46E5",
  bg: "#0A0A0A",
  panelTop: "#10101C",
  panelMid: "#0B0B14",
  panelBot: "#06060A",
  text: "#F1F2F7",
  muted: "#9AA0B4",
  hair: "rgba(255,255,255,0.10)",
};

const FONT = "Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif";

// Per-source identity: real Quivly integration accent + the signal channel it owns.
// (Mirrors QUIVLY-GROUNDING.md's signal-source table; indigo-anchored, varied accents.)
export const SIGNAL_META = {
  CRM: { color: "#6366F1", channel: "Pipeline · Salesforce" },
  Gong: { color: "#22D3EE", channel: "Call signal · Gong" },
  Stripe: { color: "#818CF8", channel: "Billing · Stripe" },
  Zendesk: { color: "#34D399", channel: "Support · Zendesk" },
  Slack: { color: "#F472B6", channel: "Sentiment · Slack" },
  Market: { color: "#FBBF24", channel: "Market · Tavily" },
};
const SOURCES = Object.keys(SIGNAL_META);

// ⚠️ Color by SCORE BUCKET, never by the risk word (it's inverted): low = HEALTHY.
// Bucket colors are grounding-exact (#22c55e / #eab308 / #f97316 / #ef4444). `amp/speed`
// drive the per-frame adrenaline pulse — hotter risk pulses harder/faster.
export const RISK_TIERS = {
  low: { key: "low", label: "HEALTHY · HOLD FIRE", color: "#22C55E", sentiment: 5, target: false, amp: 0.0, speed: 0 },
  medium: { key: "medium", label: "AT RISK", color: "#EAB308", sentiment: 3, target: true, amp: 0.10, speed: 3.0 },
  high: { key: "high", label: "HIGH RISK", color: "#F97316", sentiment: 2, target: true, amp: 0.16, speed: 4.6 },
  critical: { key: "critical", label: "CRITICAL", color: "#EF4444", sentiment: 1, target: true, amp: 0.22, speed: 6.6 },
  boss: { key: "boss", label: "RENEWAL DAY", color: "#6366F1", sentiment: 1, target: true, amp: 0.14, speed: 2.4 },
};

// Resolve any caller dialect → a tier object. Accepts tier keys, aliases, the legacy
// enemy `kind`, and a raw 0–100 health score (bucketed). Defaults to medium.
function tierFor(t) {
  if (t && typeof t === "object" && t.key && RISK_TIERS[t.key]) return RISK_TIERS[t.key];
  if (typeof t === "number" && Number.isFinite(t)) {
    if (t <= 24) return RISK_TIERS.critical;
    if (t <= 49) return RISK_TIERS.high;
    if (t <= 74) return RISK_TIERS.medium;
    return RISK_TIERS.low;
  }
  const k = String(t || "").toLowerCase();
  if (RISK_TIERS[k]) return RISK_TIERS[k];
  const alias = {
    healthy: "low", safe: "low", ok: "low",
    atrisk: "medium", "at-risk": "medium", warn: "medium", standard: "medium", signal: "medium",
    elite: "high", shielded: "high", risk: "high",
    churn: "critical", churning: "critical", brute: "critical",
  };
  return RISK_TIERS[alias[k] || "medium"];
}

// Named ranks by ARR — DESIGN.md thresholds, exact: Rookie <$5k · Defender <$15k ·
// Speedrunner <$40k · VP <$80k · CRO ≥$80k. Tier index drives the I–V medallion.
export const RANKS = [
  { tier: 1, max: 5_000, name: "Renewal Rookie", color: "#94A3B8", blurb: "First saves on the board. Keep deploying." },
  { tier: 2, max: 15_000, name: "Account Defender", color: "#34D399", blurb: "Portfolio's holding — churn's on the back foot." },
  { tier: 3, max: 40_000, name: "CSM Speedrunner", color: "#22D3EE", blurb: "Fast hands, full stack. The book is yours." },
  { tier: 4, max: 80_000, name: "VP Retention", color: "#818CF8", blurb: "Renewals on rails. Numbers up and to the right." },
  { tier: 5, max: Infinity, name: "Chief Renewal Officer", color: "#FBBF24", blurb: "Untouchable. The quarter renews itself." },
];
const ROMAN = ["", "I", "II", "III", "IV", "V"];

export function rankFor(arr) {
  const v = num(arr);
  for (const r of RANKS) if (v < r.max) return r;
  return RANKS[RANKS.length - 1];
}
// "next rank in $X": delta to the next tier's floor (= this tier's max). null if maxed.
function nextRank(arr) {
  const cur = rankFor(arr);
  if (cur.max === Infinity) return null;
  return { name: RANKS[cur.tier]?.name || "", delta: Math.max(0, cur.max - num(arr)) };
}

// Real-feeling account roster (mid-market SaaS flavor).
const ACCOUNTS = [
  "Northwind Cloud", "Lumen Labs", "Apex Retail", "Vertex Health", "Cobalt Bank",
  "Halcyon AI", "Ridgeline SaaS", "Meridian Group", "Quanta Logistics", "Beacon Foods",
  "Orbital Media", "Summit Legal", "Drift Mobility", "Cinder Energy", "Pinnacle HR",
  "Tideway Telecom", "Aster Biotech", "Granite Insurance", "Nimbus Gaming", "Verdant Agritech",
];

// ── Pure helpers (no side effects) ──────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function num(...vals) {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}

function commaARR(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

// Sentiment 1–5 → a green→red color (a happy account is green, a detractor is red).
function sentimentColor(s) {
  return s >= 5 ? "#22C55E" : s >= 4 ? "#84CC16" : s >= 3 ? "#EAB308" : s >= 2 ? "#F97316" : "#EF4444";
}

// Deterministic flavor ARR scaled by tier + Full-Stack chip stacking (the moat pays more).
function flavorARR(h, tierKey, chips) {
  const base =
    tierKey === "boss" ? 240_000 :
    tierKey === "critical" ? 92_000 :
    tierKey === "high" ? 58_000 :
    tierKey === "medium" ? 36_000 : 21_000; // low/healthy
  const jitter = 1 + (h % 42) / 100; // 1.00 .. 1.41
  const stack = 1 + 0.32 * Math.max(0, (chips || 1) - 1);
  let v = Math.round((base * jitter * stack) / 100) * 100;
  if (v >= 1_000_000) return `$${(v / 1e6).toFixed(1)}M ARR`;
  if (v >= 120_000) return `$${Math.round(v / 1000)}K ARR`;
  return `${commaARR(v)} ARR`;
}

// Deterministic renewal-state line (real field flavor: overdue / approaching / safe).
function flavorRenew(h, tierKey) {
  if (tierKey === "boss") { const d = [0, 1, 2][h % 3]; return d === 0 ? "renews today" : `${d}d to renewal`; }
  if (tierKey === "critical") { const d = [1, 2, 3, 5][h % 4]; return `${d}d overdue`; }
  if (tierKey === "high") { const d = [3, 5, 7][h % 3]; return `renews in ${d}d`; }
  if (tierKey === "medium") { const d = [10, 14, 21][h % 3]; return `renews in ${d}d`; }
  return `renews in ${[45, 60, 90][h % 3]}d`; // low / healthy
}

// Build the source list for a card: primary source + deterministic extras for multi-source.
function sourcesFor(primary, chips, h) {
  const list = [primary];
  const want = Math.min(Math.max(1, chips | 0), 4);
  if (want > 1) {
    const pool = SOURCES.filter((s) => s !== primary);
    let hh = h >>> 0;
    while (list.length < want && pool.length) {
      hh = (Math.imul(hh, 1103515245) + 12345) >>> 0;
      list.push(pool.splice(hh % pool.length, 1)[0]);
    }
  }
  return list;
}

// Greedy word-wrap to a max width (font must be set on `g` first).
function wrapLines(g, text, maxWidth, maxLines = 2) {
  const words = String(text).split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxWidth && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && g.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

// Shrink a font until `text` fits `maxWidth`; sets and returns the chosen size.
function fitFont(g, text, maxWidth, startPx, minPx, weight) {
  let px = startPx;
  while (px > minPx) {
    g.font = `${weight} ${px}px ${FONT}`;
    if (g.measureText(text).width <= maxWidth) break;
    px -= 1;
  }
  g.font = `${weight} ${px}px ${FONT}`;
  return px;
}

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

// Source glyphs — crisp line-art marks in the source accent, with a baked neon glow.
function drawGlyph(g, source, cx, cy, s, color) {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = Math.max(3, s * 0.14);
  g.shadowColor = color;
  g.shadowBlur = s * 0.7;

  switch (source) {
    case "Gong": {
      for (const k of [1, 0.62, 0.3]) {
        g.beginPath();
        g.arc(cx, cy, s * k, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case "Stripe": {
      const len = s * 1.5;
      for (let i = -1; i <= 1; i++) {
        const ox = i * s * 0.42;
        g.beginPath();
        g.moveTo(cx + ox - len * 0.3, cy + s * 0.7);
        g.lineTo(cx + ox + len * 0.3, cy - s * 0.7);
        g.stroke();
      }
      break;
    }
    case "Zendesk": {
      const a = s * 0.85;
      g.beginPath();
      g.moveTo(cx - a, cy - a);
      g.lineTo(cx + a, cy - a);
      g.lineTo(cx - a, cy + a);
      g.lineTo(cx + a, cy + a);
      g.stroke();
      break;
    }
    case "Slack": {
      const a = s * 0.95;
      const o = s * 0.4;
      g.beginPath();
      g.moveTo(cx - o, cy - a); g.lineTo(cx - o, cy + a);
      g.moveTo(cx + o, cy - a); g.lineTo(cx + o, cy + a);
      g.moveTo(cx - a, cy - o); g.lineTo(cx + a, cy - o);
      g.moveTo(cx - a, cy + o); g.lineTo(cx + a, cy + o);
      g.stroke();
      break;
    }
    case "Market": {
      g.beginPath();
      g.moveTo(cx - s, cy + s * 0.6);
      g.lineTo(cx - s * 0.3, cy - s * 0.1);
      g.lineTo(cx + s * 0.2, cy + s * 0.3);
      g.lineTo(cx + s, cy - s * 0.8);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + s * 0.45, cy - s * 0.8);
      g.lineTo(cx + s, cy - s * 0.8);
      g.lineTo(cx + s, cy - s * 0.25);
      g.stroke();
      break;
    }
    default: {
      // CRM — contact record: avatar + list lines in a rounded frame.
      g.lineWidth = Math.max(3, s * 0.12);
      roundRect(g, cx - s, cy - s * 0.8, s * 2, s * 1.6, s * 0.22);
      g.stroke();
      g.beginPath();
      g.arc(cx - s * 0.45, cy - s * 0.2, s * 0.28, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + s * 0.05, cy - s * 0.35); g.lineTo(cx + s * 0.62, cy - s * 0.35);
      g.moveTo(cx + s * 0.05, cy + s * 0.0); g.lineTo(cx + s * 0.62, cy + s * 0.0);
      g.moveTo(cx - s * 0.65, cy + s * 0.42); g.lineTo(cx + s * 0.62, cy + s * 0.42);
      g.stroke();
    }
  }
  g.restore();
}

// Sentiment readout: 5 pips, `value` filled in the sentiment color, rest faint.
function drawSentiment(g, cx, cy, value) {
  const n = 5;
  const r = 9;
  const gap = 28;
  const total = (n - 1) * gap;
  const x0 = cx - total / 2;
  const col = sentimentColor(value);
  for (let i = 0; i < n; i++) {
    const x = x0 + i * gap;
    const on = i < value;
    g.beginPath();
    g.arc(x, cy, r, 0, Math.PI * 2);
    if (on) {
      g.fillStyle = col;
      g.shadowColor = col;
      g.shadowBlur = 12;
      g.fill();
      g.shadowBlur = 0;
    } else {
      g.lineWidth = 2;
      g.strokeStyle = hexToRgba("#FFFFFF", 0.18);
      g.stroke();
    }
  }
}

// Source chip row (multi-source moat). Centers chips; flags "FULL STACK" at 3+ sources.
function drawChipRow(g, W, y, sources) {
  const full = sources.length >= 3;
  const chipH = 36;
  const padX = 13;
  const dot = 8;
  const gap = 10;

  g.font = `700 19px ${FONT}`;
  const labels = sources.map((s) => s.toUpperCase());
  const widths = labels.map((t) => dot + 8 + g.measureText(t).width + padX * 2);
  let fullW = 0;
  if (full) {
    g.font = `800 16px ${FONT}`;
    fullW = g.measureText("FULL STACK").width + padX * 2 + gap;
  }
  let total = widths.reduce((a, b) => a + b, 0) + gap * (sources.length - 1) + fullW;
  let x = (W - total) / 2;

  if (full) {
    const w = fullW - gap;
    roundRect(g, x, y - chipH / 2, w, chipH, chipH / 2);
    g.fillStyle = hexToRgba(C.indigo, 0.18);
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = hexToRgba(C.indigo, 0.85);
    g.shadowColor = C.indigo;
    g.shadowBlur = 12;
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = C.indigoSoft;
    g.font = `800 16px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("FULL STACK", x + w / 2, y + 1);
    x += fullW;
  }

  g.font = `700 19px ${FONT}`;
  for (let i = 0; i < sources.length; i++) {
    const meta = SIGNAL_META[sources[i]] || SIGNAL_META.CRM;
    const w = widths[i];
    roundRect(g, x, y - chipH / 2, w, chipH, chipH / 2);
    g.fillStyle = hexToRgba("#FFFFFF", 0.05);
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = C.hair;
    g.stroke();
    // accent dot
    g.beginPath();
    g.arc(x + padX + dot / 2, y, dot / 2, 0, Math.PI * 2);
    g.fillStyle = meta.color;
    g.shadowColor = meta.color;
    g.shadowBlur = 8;
    g.fill();
    g.shadowBlur = 0;
    // label
    g.fillStyle = C.text;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(labels[i], x + padX + dot + 8, y + 1);
    x += w + gap;
  }
}

// Draws one branded signal card onto a 2D context sized W×H (640×800).
function drawSignalCard(g, W, H, info) {
  const { source, tier, account, arr, renew, sentiment, sources } = info;
  const meta = SIGNAL_META[source] || SIGNAL_META.CRM;
  const pad = 30;
  const cw = W - pad * 2;
  const ch = H - pad * 2;

  g.clearRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  // Card body — premium dark glass, subtle vertical gradient.
  const grad = g.createLinearGradient(0, pad, 0, H - pad);
  grad.addColorStop(0, C.panelTop);
  grad.addColorStop(0.55, C.panelMid);
  grad.addColorStop(1, C.panelBot);
  roundRect(g, pad, pad, cw, ch, 36);
  g.fillStyle = grad;
  g.fill();

  // Top sheen for a glassy, high-def read.
  const sheen = g.createLinearGradient(0, pad, 0, pad + ch * 0.4);
  sheen.addColorStop(0, hexToRgba("#FFFFFF", 0.07));
  sheen.addColorStop(1, hexToRgba("#FFFFFF", 0));
  roundRect(g, pad, pad, cw, ch, 36);
  g.fillStyle = sheen;
  g.fill();

  // Tier accent strip at the very top of the card (instant risk read).
  roundRect(g, pad + 26, pad + 14, cw - 52, 6, 3);
  g.fillStyle = tier.color;
  g.shadowColor = tier.color;
  g.shadowBlur = 16;
  g.fill();
  g.shadowBlur = 0;

  // Glowing tier border (emissive → blooms in the GlowLayer).
  g.save();
  g.lineWidth = 8;
  g.strokeStyle = tier.color;
  g.shadowColor = tier.color;
  g.shadowBlur = 30;
  roundRect(g, pad + 4, pad + 4, cw - 8, ch - 8, 32);
  g.stroke();
  g.restore();

  // Inner indigo hairline for brand depth.
  g.lineWidth = 1.5;
  g.strokeStyle = hexToRgba(C.indigo, 0.28);
  roundRect(g, pad + 14, pad + 14, cw - 28, ch - 28, 24);
  g.stroke();

  // ── Header: source chip (left) + Quivly watermark (right) ──
  const hy = pad + 56;
  drawGlyph(g, source, pad + 50, hy, 17, meta.color);
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = meta.color;
  g.font = `800 28px ${FONT}`;
  g.fillText(source.toUpperCase(), pad + 84, hy - 9);
  g.fillStyle = C.muted;
  g.font = `500 19px ${FONT}`;
  g.fillText(meta.channel, pad + 84, hy + 18);

  // Quivly watermark
  g.fillStyle = C.indigo;
  roundRect(g, W - pad - 116, hy - 9, 18, 18, 5);
  g.fill();
  g.fillStyle = hexToRgba("#FFFFFF", 0.62);
  g.textAlign = "left";
  g.font = `700 18px ${FONT}`;
  g.fillText("quivly", W - pad - 90, hy);

  // ── Hero glyph ──
  drawGlyph(g, source, W / 2, H * 0.345, Math.round(W * 0.16), meta.color);

  // ── Account name ──
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillStyle = C.text;
  g.font = `800 ${Math.round(W * 0.072)}px ${FONT}`;
  g.shadowColor = hexToRgba("#000000", 0.55);
  g.shadowBlur = 10;
  g.fillText(account, W / 2, H * 0.55);
  g.shadowBlur = 0;

  // ── Risk badge pill ──
  const badge = tier.label;
  g.font = `800 ${Math.round(W * 0.044)}px ${FONT}`;
  const bw = g.measureText(badge).width + 52;
  const bx = (W - bw) / 2;
  const bh = Math.round(H * 0.062);
  const by = H * 0.585;
  roundRect(g, bx, by, bw, bh, bh / 2);
  g.fillStyle = hexToRgba(tier.color, 0.16);
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = hexToRgba(tier.color, 0.95);
  g.shadowColor = tier.color;
  g.shadowBlur = 16;
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = tier.color;
  g.textBaseline = "middle";
  g.fillText(badge, W / 2, by + bh / 2 + 1);

  // ── Sentiment row ──
  g.textBaseline = "alphabetic";
  g.textAlign = "center";
  g.fillStyle = C.muted;
  g.font = `600 16px ${FONT}`;
  g.fillText("SENTIMENT", W / 2, H * 0.685);
  drawSentiment(g, W / 2, H * 0.722, sentiment);

  // ── Source chips (multi-source moat) ──
  drawChipRow(g, W, H * 0.79, sources);

  // ── Footer: ARR (left) · renewal (right) with a divider ──
  const fy = H - pad - 34;
  g.strokeStyle = hexToRgba("#FFFFFF", 0.09);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad + 28, fy - 20);
  g.lineTo(W - pad - 28, fy - 20);
  g.stroke();
  g.textBaseline = "middle";
  g.font = `700 22px ${FONT}`;
  g.textAlign = "left";
  g.fillStyle = C.text;
  g.fillText(arr, pad + 30, fy + 4);
  g.textAlign = "right";
  g.fillStyle = tier.target ? tier.color : C.muted;
  g.font = `600 21px ${FONT}`;
  g.fillText(renew, W - pad - 30, fy + 4);
}

// ── Result card (shareable, HD) ─────────────────────────────────────────────────
function drawResultCard(canvas, r) {
  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
  const W = 1200;
  const H = 675;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const won = !!r.won;
  const accent = won ? "#34D399" : "#F87171";
  const rk = rankFor(r.arr);

  // Background.
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#07070B");
  bg.addColorStop(1, "#0C0C18");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.82, H * 0.16, 40, W * 0.82, H * 0.16, 660);
  glow.addColorStop(0, hexToRgba(won ? C.indigo : "#F87171", 0.22));
  glow.addColorStop(1, hexToRgba(C.indigo, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Faint grid.
  g.strokeStyle = hexToRgba("#FFFFFF", 0.03);
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

  // Inner neon frame.
  g.save();
  g.strokeStyle = hexToRgba(C.indigo, 0.35);
  g.lineWidth = 2;
  roundRect(g, 24, 24, W - 48, H - 48, 22);
  g.stroke();
  g.restore();

  const pad = 72;

  // Brand row.
  g.fillStyle = C.indigo;
  roundRect(g, pad, 58, 22, 22, 6);
  g.fill();
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = C.text;
  g.font = `800 26px ${FONT}`;
  g.fillText("QUIVLY", pad + 34, 70);
  g.fillStyle = C.muted;
  g.font = `600 18px ${FONT}`;
  g.fillText("RENEWAL RUSH", pad + 144, 71);

  // Win/lose status chip (right).
  g.font = `800 16px ${FONT}`;
  const chip = won ? "CLOSED-WON" : "CHURNED";
  const chW = g.measureText(chip).width + 40;
  roundRect(g, W - pad - chW, 56, chW, 30, 15);
  g.fillStyle = hexToRgba(accent, 0.16);
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = hexToRgba(accent, 0.9);
  g.stroke();
  g.fillStyle = accent;
  g.textAlign = "center";
  g.fillText(chip, W - pad - chW / 2, 72);

  // Headline (script beat).
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 32;
  g.fillStyle = accent;
  g.font = `800 88px ${FONT}`;
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillText(won ? "RENEWAL SAVED" : "RENEWAL LOST", pad, 210);
  g.restore();

  // Rank medallion (right): I–V numeral + named rank.
  const rcx = W - 206;
  const rcy = 248;
  const rr = 108;

  // Subtitle — Quivly voice. Width-guarded to the left column so it never
  // collides with the medallion (right edge ≈ rcx - rr).
  let sub;
  if (won) {
    sub = `You saved the quarter — renewal closed-won. Your post-sales team, without the headcount.`;
  } else {
    const e = num(r.escaped);
    sub = `Churn got there first — ${e} signal${e === 1 ? "" : "s"} slipped through. Quivly would've had the draft ready.`;
  }
  g.fillStyle = C.muted;
  g.font = `500 24px ${FONT}`;
  const subMax = rcx - rr - pad - 28;
  const subLines = wrapLines(g, sub, subMax, 2);
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  for (let i = 0; i < subLines.length; i++) g.fillText(subLines[i], pad, 246 + i * 32);
  g.save();
  g.beginPath();
  g.arc(rcx, rcy, rr, 0, Math.PI * 2);
  g.fillStyle = hexToRgba(rk.color, 0.08);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = rk.color;
  g.shadowColor = rk.color;
  g.shadowBlur = 28;
  g.stroke();
  g.restore();
  g.fillStyle = rk.color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `800 96px ${FONT}`;
  g.fillText(ROMAN[rk.tier] || "I", rcx, rcy + 4);
  g.fillStyle = C.muted;
  g.font = `600 15px ${FONT}`;
  g.fillText("RANK", rcx, rcy - rr + 26);
  // Rank name — shrink-to-fit the symmetric room around the medallion.
  g.fillStyle = C.text;
  const nameMax = 2 * Math.min(rcx - pad, W - pad - rcx);
  fitFont(g, rk.name, nameMax, 24, 16, "800");
  g.fillText(rk.name, rcx, rcy + rr + 30);

  // Stats grid — real game fields only.
  const stats = [
    { label: "ARR SAVED", value: commaARR(r.arr), color: "#FCD34D" },
    { label: "DEPLOYS", value: String(num(r.deploys)), color: C.text },
    { label: "BEST COMBO", value: "×" + num(r.maxCombo), color: C.indigoSoft },
    { label: "HEALTH", value: Math.round(num(r.health)) + "%", color: r.health >= 60 ? "#34D399" : r.health >= 30 ? "#FBBF24" : "#F87171" },
  ];
  const gy = 350;
  const cellW = (W - pad * 2 - 220) / stats.length; // leave room under the medallion
  for (let i = 0; i < stats.length; i++) {
    const cx = pad + i * cellW;
    const s = stats[i];
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    g.fillStyle = s.color;
    g.font = `800 52px ${FONT}`;
    g.fillText(s.value, cx, gy + 86);
    g.fillStyle = C.muted;
    g.font = `600 17px ${FONT}`;
    g.fillText(s.label, cx, gy + 118);
  }

  // Rank blurb + "next rank in $X".
  g.fillStyle = hexToRgba("#FFFFFF", 0.72);
  g.font = `500 22px ${FONT}`;
  g.fillText(rk.blurb, pad, gy + 174);
  const nx = nextRank(r.arr);
  if (nx) {
    g.fillStyle = C.indigoSoft;
    g.font = `600 20px ${FONT}`;
    g.fillText(`Next rank: ${nx.name} in ${commaARR(nx.delta)}`, pad, gy + 206);
  }

  // Footer — CTA (Quivly voice) + hashtag.
  const fy = H - 54;
  g.strokeStyle = hexToRgba("#FFFFFF", 0.08);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad, fy - 26);
  g.lineTo(W - pad, fy - 26);
  g.stroke();
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = C.text;
  g.font = `600 21px ${FONT}`;
  g.fillText("Quivly does this for real, autonomously — ", pad, fy);
  const w1 = g.measureText("Quivly does this for real, autonomously — ").width;
  g.fillStyle = C.indigoSoft;
  g.font = `800 21px ${FONT}`;
  g.fillText("book a demo → app.quivly.ai", pad + w1, fy);
  g.textAlign = "right";
  g.fillStyle = C.muted;
  g.font = `600 20px ${FONT}`;
  g.fillText("#RenewalRush", W - pad, fy);
}

// ── Result overlay CSS (sharp, light backdrop; the card carries the look) ─────────
const OVERLAY_CSS = `
.rrb-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
 background:radial-gradient(1200px 800px at 50% 24%,rgba(99,102,241,.16),rgba(7,7,11,.82)),rgba(6,6,9,.78);
 -webkit-backdrop-filter:blur(7px) saturate(120%);backdrop-filter:blur(7px) saturate(120%);
 opacity:0;transition:opacity .4s ease;font-family:${FONT};padding:24px;box-sizing:border-box;}
.rrb-overlay.rrb-show{opacity:1;}
.rrb-card{display:flex;flex-direction:column;gap:18px;align-items:center;max-width:min(94vw,820px);width:100%;
 transform:translateY(16px) scale(.985);transition:transform .55s cubic-bezier(.16,1,.3,1);}
.rrb-overlay.rrb-show .rrb-card{transform:none;}
.rrb-shot{width:100%;height:auto;aspect-ratio:1200 / 675;border-radius:18px;border:1px solid rgba(99,102,241,.4);
 box-shadow:0 30px 90px -20px rgba(0,0,0,.85),0 0 70px -12px rgba(99,102,241,.5);display:block;
 image-rendering:-webkit-optimize-contrast;}
.rrb-actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;width:100%;}
.rrb-btn{appearance:none;border:1px solid rgba(241,242,247,.16);background:rgba(255,255,255,.05);
 color:${C.text};font:600 15px/1 ${FONT};padding:14px 22px;border-radius:12px;cursor:pointer;letter-spacing:.2px;
 transition:transform .15s ease,background .2s ease,border-color .2s ease;text-decoration:none;
 display:inline-flex;align-items:center;justify-content:center;gap:8px;}
.rrb-btn:hover{transform:translateY(-2px);background:rgba(255,255,255,.09);border-color:rgba(241,242,247,.3);}
.rrb-btn:active{transform:translateY(0);}
.rrb-primary{background:linear-gradient(180deg,${C.indigo},${C.indigoDeep});border-color:transparent;color:#fff;
 box-shadow:0 12px 32px -8px rgba(99,102,241,.7);}
.rrb-primary:hover{background:linear-gradient(180deg,#7376f4,#5b52f0);}
.rrb-close{position:absolute;top:18px;right:20px;width:42px;height:42px;border-radius:50%;
 border:1px solid rgba(241,242,247,.18);background:rgba(255,255,255,.06);color:${C.text};font-size:22px;
 cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;}
.rrb-close:hover{background:rgba(255,255,255,.12);}
@media (max-width:560px){.rrb-btn{flex:1 1 42%;}}
@media (prefers-reduced-motion:reduce){.rrb-overlay,.rrb-card{transition-duration:.01ms;}}
`;

// ── Factory ─────────────────────────────────────────────────────────────────────
export function createBrand(ctx = {}) {
  const { scene: rootScene, game, bus, onFrame } = ctx;
  let disposed = false;
  let cardId = 0;

  // Texture/material cache keyed by (tier|source|chips) — bounded (≈ tiers×sources×chips),
  // no per-spawn seed, so pooled enemies can share materials without unbounded GPU growth.
  const cache = new Map();

  // Result overlay state.
  let styleEl = null;
  let overlay = null;
  let shotCanvas = null;
  let shareBtn = null;
  let copyBtn = null;
  let lastResult = null;
  let keyHandler = null;

  function buildEntry(scene, key, source, tier, chips) {
    const W = 640;
    const H = 800;
    const tex = new DynamicTexture(`brand-tex:${key}`, { width: W, height: H }, scene, true);
    tex.hasAlpha = true;
    const h = hashStr(key);
    const info = {
      source,
      tier,
      account: ACCOUNTS[h % ACCOUNTS.length],
      arr: flavorARR((h >>> 3) % 997, tier.key, chips),
      renew: flavorRenew((h >>> 7) % 991, tier.key),
      sentiment: tier.sentiment,
      sources: sourcesFor(source, chips, h),
    };
    const g = tex.getContext();
    g.imageSmoothingEnabled = true;
    drawSignalCard(g, W, H, info);
    tex.update(); // matches the prior baseline; orientation to confirm in GPU playtest

    const mat = new StandardMaterial(`brand-mat:${key}`, scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;

    return { tex, mat, amp: tier.amp, speed: tier.speed, phase: (h % 628) / 100 };
  }

  // (1) Branded signal-card mesh. Returns a pickable, double-sided, Y-billboard plane.
  //     enemies.js owns mesh.metadata; we only stamp `brandInfo` (non-conflicting).
  //     opts: { width, height, chips, billboard, boss }
  function makeSignalCard(scene, source, riskTier, opts = {}) {
    const sc = scene || rootScene;
    if (!sc) return null;
    const src = SIGNAL_META[source] ? source : "CRM";
    const tier = tierFor(riskTier);
    const chips = Math.min(Math.max(1, (opts.chips | 0) || 1), 4);
    const key = `${tier.key}|${src}|${chips}`;

    let entry = cache.get(key);
    if (!entry) {
      entry = buildEntry(sc, key, src, tier, chips);
      cache.set(key, entry);
    }

    const big = (tier.key === "boss" || opts.boss) ? 1.7 : 1;
    const card = MeshBuilder.CreatePlane(
      `signal-card:${key}:${cardId++}`,
      {
        width: (opts.width ?? 1.2) * big,
        height: (opts.height ?? 1.5) * big,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      sc
    );
    card.material = entry.mat;
    // Y-billboard keeps the card upright + facing the player (also hides the mirrored
    // back face). Pass opts.billboard:false to let enemies orient it manually.
    card.billboardMode = opts.billboard === false ? Mesh.BILLBOARDMODE_NONE : Mesh.BILLBOARDMODE_Y;
    card.isPickable = true;
    card.brandInfo = { source: src, tier: tier.key, chips }; // enemies sets metadata itself
    return card;
  }

  // ── Result card + share/copy overlay ──────────────────────────────────────────
  function resolveResult(partial = {}) {
    const gm = game || {};
    const health = num(partial.health, gm.health, 0);
    const arr = num(partial.arr, gm.arr, 0);
    const won = partial.won != null ? !!partial.won : gm.status === "won";
    return {
      won,
      arr,
      rank: rankFor(arr).name,
      health,
      deploys: num(partial.deploys, gm.deploys, 0),
      maxCombo: num(partial.maxCombo, gm.maxCombo, 0),
      escaped: num(partial.escaped, gm.escaped, 0),
      timeLeftMs: num(partial.timeLeftMs, gm.timeLeft, 0),
    };
  }

  function ensureStyle() {
    if (styleEl || typeof document === "undefined") return;
    styleEl = document.createElement("style");
    styleEl.id = "rrb-style";
    styleEl.textContent = OVERLAY_CSS;
    document.head.appendChild(styleEl);
  }

  function shareText(r) {
    return r.won
      ? `I saved ${commaARR(r.arr)} ARR before renewal day in Renewal Rush — rank ${r.rank}. Can you beat it?`
      : `Renewal day got me in Renewal Rush. Think you can save the accounts?`;
  }

  async function doShare() {
    if (!shotCanvas) return;
    const text = shareText(lastResult || {});
    const url = "https://app.quivly.ai";
    try {
      const blob = await new Promise((res) => shotCanvas.toBlob(res, "image/png"));
      if (blob && navigator.canShare) {
        const file = new File([blob], "renewal-rush.png", { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Renewal Rush", text, url });
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({ title: "Renewal Rush", text, url });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return; // user cancelled
    }
    doDownload(); // fallback (also covers iframes without allow="web-share")
  }

  function flashBtn(btn, label) {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { if (!disposed && btn.isConnected) btn.textContent = prev; }, 1500);
  }

  // Copy the result image to the clipboard; fall back to copying the share text + URL.
  async function doCopy() {
    if (!shotCanvas) return;
    try {
      const blob = await new Promise((res) => shotCanvas.toBlob(res, "image/png"));
      if (blob && navigator.clipboard && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        flashBtn(copyBtn, "Copied ✓");
        return;
      }
    } catch (e) { /* fall through to text copy */ }
    try {
      await navigator.clipboard.writeText(`${shareText(lastResult || {})} https://app.quivly.ai`);
      flashBtn(copyBtn, "Link copied ✓");
    } catch (e) {
      doDownload();
    }
  }

  function doDownload() {
    if (!shotCanvas) return;
    try {
      const a = document.createElement("a");
      a.href = shotCanvas.toDataURL("image/png");
      a.download = "renewal-rush-result.png";
      a.click();
    } catch (e) { /* tainted/blocked canvas — ignore */ }
  }

  function hideOverlay() {
    if (overlay) overlay.classList.remove("rrb-show");
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "rrb-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Renewal Rush result");

    const close = document.createElement("button");
    close.className = "rrb-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", hideOverlay);

    const card = document.createElement("div");
    card.className = "rrb-card";

    shotCanvas = document.createElement("canvas");
    shotCanvas.className = "rrb-shot";
    shotCanvas.setAttribute("role", "img");
    shotCanvas.setAttribute("aria-label", "Renewal Rush result card");

    const actions = document.createElement("div");
    actions.className = "rrb-actions";

    shareBtn = document.createElement("button");
    shareBtn.className = "rrb-btn";
    shareBtn.type = "button";
    shareBtn.textContent = (typeof navigator !== "undefined" && navigator.share) ? "Share result" : "Save image";
    shareBtn.addEventListener("click", doShare);

    copyBtn = document.createElement("button");
    copyBtn.className = "rrb-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", doCopy);

    const dl = document.createElement("button");
    dl.className = "rrb-btn";
    dl.type = "button";
    dl.textContent = "Download";
    dl.addEventListener("click", doDownload);

    const demo = document.createElement("a");
    demo.className = "rrb-btn rrb-primary";
    demo.href = "https://app.quivly.ai";
    demo.target = "_blank";
    demo.rel = "noopener noreferrer";
    demo.textContent = "Book a demo →";

    const play = document.createElement("button");
    play.className = "rrb-btn";
    play.type = "button";
    play.textContent = "Play again";
    play.addEventListener("click", () => {
      hideOverlay();
      bus?.emit?.("start");
      try { window.location.reload(); } catch (e) { /* no-op */ }
    });

    actions.append(shareBtn, copyBtn, dl, demo, play);
    card.append(shotCanvas, actions);
    overlay.append(close, card);
    document.body.appendChild(overlay);

    keyHandler = (ev) => {
      if (ev.key === "Escape" && overlay && overlay.classList.contains("rrb-show")) hideOverlay();
    };
    document.addEventListener("keydown", keyHandler);
  }

  // (2) Public: render + show the shareable result card with CTA overlay.
  function showResult(partial = {}) {
    if (disposed || typeof document === "undefined") return;
    lastResult = resolveResult(partial);
    ensureStyle();
    if (!overlay) buildOverlay();
    if (!overlay.isConnected) document.body.appendChild(overlay);

    drawResultCard(shotCanvas, lastResult);
    if (shareBtn) shareBtn.textContent = navigator.share ? "Share result" : "Save image";
    if (copyBtn) copyBtn.textContent = "Copy";

    // Free the cursor so the buttons are clickable.
    try { document.exitPointerLock?.(); } catch (e) { /* no-op */ }

    // Force reflow, then animate in.
    void overlay.offsetWidth;
    requestAnimationFrame(() => overlay && overlay.classList.add("rrb-show"));
  }

  // Wire end-of-run events.
  const onWin = () => showResult({ won: true });
  const onLose = () => showResult({ won: false });
  bus?.on?.("win", onWin);
  bus?.on?.("lose", onLose);

  // Subtle adrenaline pulse on at-risk cards (shared materials → in-unison, cheap).
  let pulseT = 0;
  onFrame?.((dt) => {
    if (disposed) return;
    pulseT += dt || 0;
    for (const e of cache.values()) {
      if (e.amp <= 0) continue;
      const v = 1 + e.amp * Math.sin(pulseT * e.speed + e.phase);
      e.mat.emissiveColor.set(v, v, v);
    }
  });

  function dispose() {
    disposed = true;
    bus?.off?.("win", onWin);
    bus?.off?.("lose", onLose);
    if (keyHandler && typeof document !== "undefined") {
      try { document.removeEventListener("keydown", keyHandler); } catch (e) { /* no-op */ }
    }
    for (const e of cache.values()) {
      e.mat?.dispose();
      e.tex?.dispose();
    }
    cache.clear();
    overlay?.remove();
    styleEl?.remove();
    overlay = null;
    styleEl = null;
    shotCanvas = null;
    shareBtn = null;
    copyBtn = null;
    keyHandler = null;
  }

  return {
    makeSignalCard,
    showResult,
    dispose,
    // Exported labels/ranks for HUD or others.
    ranks: RANKS,
    rankFor,
    signals: SIGNAL_META,
    tiers: RISK_TIERS,
    labelFor: (t) => tierFor(t).label,
  };
}
