// audio.js — Renewal Rush sound engine (Quivly-themed).
// Dependency-free WebAudio: no Babylon, no libraries, no top-level side effects.
// Exposes createAudio(ctx) -> { play, setIntensity, intensity, resume, dispose }.
//
// Theme: you are a deployed Quivly AI agent. Sound makes the product *feel* real —
// every churn signal you neutralize is an agent DEPLOYED, and the richer the signal
// (more sources stacked) the bigger the reward read. Quivly's moat — "CRM said
// healthy, usage said otherwise, Quivly saw both" — is the Full-Stack fanfare.
//
// Highlights:
//  - tone(freq, durSec, type, vol, slideToFreq, when, dest): a SINGLE correct
//    primitive with a real pitch slide (setValueAtTime + exponentialRampToValueAtTime
//    on the oscillator's frequency). `when` lets stings/arps be scheduled ahead.
//  - Per-SOURCE signal stings — CRM, Gong, Stripe, Zendesk, Slack, Market each render
//    a distinct timbre/contour (corporate fifth · vocal swell · cash ka-ching · support
//    bell · Slack knock · radar sweep). Source is taken from the kill payload when
//    present, otherwise derived from position/sequence (see resolveKill).
//  - A satisfying DEPLOY confirm under every neutralize, a two-source layered sting
//    for elites, a Full-Stack multi-source FANFARE for 3+ source cards, a seeker-
//    resolved cue for pursuing churn, and a boss renewal-saved flourish.
//  - Health-WARNING + critical/Last-Stand cues with hysteresis, a sustained heartbeat
//    under critical health, and a Renewal-Day announcement + ticking clock layer in
//    the final ~20s — all driven self-contained from game state in onFrame.
//  - A layered, intensity-gated music bed (sub, bass pulse, pad chord, arpeggio,
//    hats, crescendo lead, clock tick) scheduled on the audio clock. Intensity tracks
//    game.threat and ramps into the renewal-day crescendo over the final 20s.
//  - AudioContext is resumed on the first user gesture (browsers start it suspended).

const A4 = 440;
// MIDI -> Hz. mtof(69) === 440.
const mtof = (m) => A4 * Math.pow(2, (m - 69) / 12);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A2 root for the bed; minor-pentatonic for tense-but-hummable SaaS neon.
const ROOT = 45; // A2 ~= 110 Hz
const PENT = [0, 3, 5, 7, 10];
// Triad used by the pad (A minor: root, b3, 5).
const PAD = [0, 3, 7];

// The real Quivly signal sources (mirrors game.js SIGNALS). Each gets its own voice.
const SOURCES = ["CRM", "Gong", "Stripe", "Zendesk", "Slack", "Market"];

// Per-source sting "voices" — data-driven so a base `when` threads cleanly through
// every note. Each note: [midi, durSec, oscType, vol, slideToMidi, atOffsetSec].
// The accent fields (coin/whoosh) add the source's signature texture.
//  CRM (Salesforce/HubSpot): clean corporate fifth — orderly, bright.
//  Gong (calls/conversation): warm vocal swell with a detuned shadow.
//  Stripe (billing): bright metallic ka-ching + cash shimmer.
//  Zendesk (support): a calm "ticket resolved" bell ding.
//  Slack (comms): a poppy two-note knock ("ba-dum").
//  Market (web/Tavily): an airy radar sweep + whoosh — "detected externally".
const SOURCE_VOICE = {
  CRM: { notes: [[72, 0.07, "sine", 0.05, 74, 0], [79, 0.11, "triangle", 0.045, 79, 0.05]] },
  Gong: { notes: [[67, 0.16, "triangle", 0.05, 74, 0], [70, 0.16, "sine", 0.03, 76, 0]] },
  Stripe: { notes: [[88, 0.05, "sine", 0.05, 95, 0], [83, 0.1, "triangle", 0.04, 90, 0.03]], coin: 0.0 },
  Zendesk: { notes: [[84, 0.18, "sine", 0.05, 86, 0], [72, 0.2, "sine", 0.025, 72, 0]] },
  Slack: { notes: [[81, 0.06, "triangle", 0.05, 81, 0], [76, 0.09, "triangle", 0.045, 76, 0.06]] },
  Market: { notes: [[60, 0.22, "sawtooth", 0.035, 96, 0]], whoosh: { hp: 1500, dur: 0.22, vol: 0.04 } },
};

export function createAudio(ctx) {
  const bus = ctx?.bus;
  const game = ctx?.game;

  let ac = null; // AudioContext (lazy)
  let master = null; // limiter -> destination
  let sfxBus = null; // SFX gain
  let musicBus = null; // music gain
  let noise = null; // shared noise buffer (hats / whooshes)
  let disposed = false;

  // ---- intensity model -------------------------------------------------------
  // effective target = max(auto threat/crescendo/combo, held manual level, decaying bump)
  let intensity = 0; // smoothed, drives layer gating + tempo
  let manualLevel = 0; // public setIntensity(x) — held until changed
  let bump = 0; // event reactivity (kills/combos), decays fast

  // ---- per-round one-shot state ----------------------------------------------
  // Reset whenever a new run begins (status transitions back to "running").
  let lowWarned = false; // health crossed below ~30
  let critWarned = false; // health crossed below ~20 (Last Stand band)
  let renewalAnnounced = false; // the one-shot "renewal day is here" sting
  let hbT = 0; // heartbeat accumulator (critical health)
  let srcCounter = 0; // fallback rotation for per-source stings
  let prevStatus = null; // run-transition detector
  let renewalPhase = 0; // 0 none · 1 final 20s · 2 final 10s (drives clock tick)

  // ---- Total Overdose style intensity ----------------------------------------
  // Music bed intensity gains a FLOOR from the current style rank (held from the
  // last bus "style" event — a rank drop is itself a "style" change). Calmer at
  // Cool, driving at OVERDOSE. styleRankIdx gates the rank-up stinger.
  let styleFloor = 0; // 0..1 intensity floor from style rank
  let styleRankIdx = -1; // -1 none yet; 0 cool · 1 hot · 2 loco · 3 overdose

  // ---- music scheduler state -------------------------------------------------
  const music = { running: false, step: 0, nextTime: 0, timer: null };
  let lastPaused = false; // for transition-gated ducking

  // --------------------------------------------------------------------------
  // Audio graph (built on first real use, after a context exists).
  // --------------------------------------------------------------------------
  function ensureCtx() {
    if (disposed) return null;
    if (ac) return ac;
    const Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    ac = new Ctor();

    // Master limiter so stacked deploys + bed never clip harshly.
    master = ac.createDynamicsCompressor();
    master.threshold.value = -10;
    master.knee.value = 24;
    master.ratio.value = 12;
    master.attack.value = 0.003;
    master.release.value = 0.18;
    master.connect(ac.destination);

    sfxBus = ac.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);

    musicBus = ac.createGain();
    musicBus.gain.value = 0.0; // faded up when the bed starts
    musicBus.connect(master);

    return ac;
  }

  function resume() {
    const c = ensureCtx();
    if (c && c.state === "suspended") c.resume().catch(() => {});
    return c;
  }

  function noiseBuf() {
    if (noise || !ac) return noise;
    const len = Math.floor(ac.sampleRate * 0.3);
    const b = ac.createBuffer(1, len, ac.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noise = b;
    return noise;
  }

  // --------------------------------------------------------------------------
  // tone(): the one true primitive. slideToFreq, when present & valid, glides the
  // oscillator from freq -> slideToFreq across the note (the fixed pitch-slide bug).
  // when = optional start offset in seconds (for arps/stings); dest = bus.
  // --------------------------------------------------------------------------
  function tone(freq, durSec = 0.12, type = "sine", vol = 0.05, slideToFreq = null, when = 0, dest = null) {
    const c = ensureCtx();
    if (!c || c.state === "closed") return;
    const bus2 = dest || sfxBus;
    const t0 = c.currentTime + Math.max(0, when);
    const dur = Math.max(0.02, durSec);
    const f0 = Math.max(1, freq);

    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (slideToFreq != null && slideToFreq > 0 && Math.abs(slideToFreq - f0) > 0.5) {
      // Exponential glide — both endpoints are > 0, so this is well-defined.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideToFreq), t0 + dur);
    }

    const peak = Math.max(0.0002, vol);
    const atk = Math.min(0.012, dur * 0.3);
    g.gain.setValueAtTime(0.0002, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0002, t0 + dur);

    osc.connect(g).connect(bus2);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    osc.onended = () => {
      try { osc.disconnect(); g.disconnect(); } catch (_) {}
    };
  }

  // Soft, slow-attack pad voice (music only).
  function pad(freq, durSec, vol, when = 0) {
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + Math.max(0, when);
    const osc = c.createOscillator();
    const lp = c.createBiquadFilter();
    const g = c.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, t0);
    osc.detune.value = (Math.random() * 2 - 1) * 6; // gentle chorus
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    lp.Q.value = 0.6;
    const peak = Math.max(0.0002, vol);
    g.gain.setValueAtTime(0.0002, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + durSec * 0.4); // slow swell
    g.gain.exponentialRampToValueAtTime(0.0002, t0 + durSec);
    osc.connect(lp).connect(g).connect(musicBus);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.05);
    osc.onended = () => { try { osc.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} };
  }

  // Filtered noise tick (hats) / whoosh.
  function noiseHit(when, vol, { hp = 7000, dur = 0.045, dest = null } = {}) {
    const c = ensureCtx();
    if (!c) return;
    const buf = noiseBuf();
    if (!buf) return;
    const t0 = c.currentTime + Math.max(0, when);
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = buf;
    f.type = "highpass";
    f.frequency.value = hp;
    g.gain.setValueAtTime(Math.max(0.0002, vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0002, t0 + dur);
    src.connect(f).connect(g).connect(dest || musicBus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch (_) {} };
  }

  // --------------------------------------------------------------------------
  // bark(): formant-ish vocal stab for the announcer — a sawtooth (rich
  // harmonics) shaped by parallel bandpass "formant" filters so it reads as a
  // punchy vowel/voice, NO samples. pitch slides freq -> slideTo for inflection.
  // formants: [[freqHz, Q], …] choose the vowel color. Routed to sfxBus.
  // --------------------------------------------------------------------------
  function bark(pitch, formants, dur = 0.18, vol = 0.06, slideTo = null, when = 0) {
    const c = ensureCtx();
    if (!c || c.state === "closed") return;
    const t0 = c.currentTime + Math.max(0, when);
    const d = Math.max(0.04, dur);
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(Math.max(1, pitch), t0);
    if (slideTo != null && slideTo > 0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + d);
    }
    const g = c.createGain();
    const peak = Math.max(0.0002, vol);
    g.gain.setValueAtTime(0.0002, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, d * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0002, t0 + d);
    const nodes = [osc, g];
    const fs = formants && formants.length ? formants : [[700, 8], [1100, 9]];
    for (const [ff, q] of fs) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = ff;
      bp.Q.value = q || 8;
      osc.connect(bp).connect(g);
      nodes.push(bp);
    }
    g.connect(sfxBus);
    osc.start(t0);
    osc.stop(t0 + d + 0.04);
    osc.onended = () => { try { for (const n of nodes) n.disconnect(); } catch (_) {} };
  }

  // --------------------------------------------------------------------------
  // Per-source signal sting — render a SOURCE_VOICE at a base `when` and `power`.
  // This is the "each source sounds slightly distinct" layer.
  // --------------------------------------------------------------------------
  function signalSting(source, power = 1, when = 0) {
    const v = SOURCE_VOICE[source] || SOURCE_VOICE.CRM;
    for (const [m, dur, type, vol, slide, at] of v.notes) {
      tone(mtof(m), dur, type, vol * power, slide ? mtof(slide) : null, when + at, sfxBus);
    }
    if (v.coin != null) SFX.coin(when); // Stripe's cash shimmer
    if (v.whoosh) noiseHit(when, (v.whoosh.vol || 0.04) * power, { hp: v.whoosh.hp, dur: v.whoosh.dur, dest: sfxBus });
  }

  // Pick which source a kill "sounds like": explicit payload source wins; otherwise
  // derive deterministically from world position (same card -> same voice); finally
  // fall back to an even rotation. (The {arr,kind,position} kill payload carries no
  // source today — see module risks.)
  function deriveSourceIndex(p) {
    if (p && typeof p.source === "string") {
      const i = SOURCES.indexOf(p.source);
      if (i >= 0) return i;
    }
    const pos = p && p.position;
    if (pos && typeof pos.x === "number" && typeof pos.z === "number") {
      return Math.abs(Math.round(pos.x * 7 + pos.z * 13)) % SOURCES.length;
    }
    return (srcCounter++) % SOURCES.length;
  }

  // Route a neutralized signal to the right reward read, by source-count tier.
  // kind -> chips: signal 1 · elite 2 · shielded 3 · churn 2(seeker) · boss 5.
  function resolveKill(p) {
    const kind = (p && p.kind) || "signal";
    SFX.deploy(); // satisfying confirm under everything — "agent deployed"
    switch (kind) {
      case "boss":
        SFX.bossDown(); // renewal account saved at the gate
        break;
      case "shielded":
        SFX.fullStack(); // 3 sources -> Quivly's moat fanfare
        break;
      case "elite": {
        // 2 stacked sources — layer two distinct voices, then a unifying shimmer.
        const i = deriveSourceIndex(p);
        signalSting(SOURCES[i], 0.85, 0);
        signalSting(SOURCES[(i + 2) % SOURCES.length], 0.7, 0.05);
        tone(mtof(96), 0.3, "sine", 0.02, mtof(103), 0.08, sfxBus);
        break;
      }
      case "churn":
        SFX.churnResolved(); // a pursuing risk neutralized
        break;
      case "signal":
      default:
        signalSting(SOURCES[deriveSourceIndex(p)], 1, 0);
        break;
    }
  }

  // --------------------------------------------------------------------------
  // SFX bank — each tuned for adrenaline + a touch of surprise.
  // --------------------------------------------------------------------------
  const SFX = {
    // Deploy beam (left-click hitscan): bright zap sweeping down + a punchy body.
    fire() {
      tone(1500, 0.07, "sawtooth", 0.05, 360);
      tone(900, 0.06, "triangle", 0.035, 700);
    },
    // Agent Pulse (AoE deploy): rising charge + airy whoosh.
    pulse() {
      tone(220, 0.22, "sawtooth", 0.06, 1300);
      tone(440, 0.18, "sine", 0.04, 880);
      noiseHit(0, 0.05, { hp: 1200, dur: 0.22, dest: sfxBus });
    },
    // SHOOTDODGE dive (bus "dive"): slow-mo "whoosh" — a descending pitch drop +
    // a noise sweep through a downward bandpass = the world dropping into bullet-time.
    diveWhoosh() {
      tone(900, 0.5, "sine", 0.05, 120, 0, sfxBus); // pitch-drop tail
      tone(1400, 0.45, "triangle", 0.03, 200, 0.02, sfxBus);
      const c = ensureCtx();
      if (!c || c.state === "closed") return;
      const buf = noiseBuf();
      if (!buf) return;
      const t0 = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true; // 0.3s buffer looped under the 0.55s sweep
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(4200, t0);
      bp.frequency.exponentialRampToValueAtTime(280, t0 + 0.5); // sweep DOWN = slowing
      const g = c.createGain();
      g.gain.setValueAtTime(0.0002, t0);
      g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0002, t0 + 0.55);
      src.connect(bp).connect(g).connect(sfxBus);
      src.start(t0);
      src.stop(t0 + 0.6);
      src.onended = () => { try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch (_) {} };
    },
    // Satisfying DEPLOY confirm — a tight up-chirp + tick. Underlays every neutralize.
    deploy() {
      tone(960, 0.05, "triangle", 0.04, 1440);
      noiseHit(0, 0.018, { hp: 5200, dur: 0.04, dest: sfxBus });
    },
    // Generic neutralize (kept for play("kill") back-compat; the bus routes to
    // resolveKill for the richer per-source/tier reads).
    kill(p) {
      resolveKill(p);
    },
    // ARR saved chime (also Stripe's accent).
    coin(when = 0) {
      tone(1175, 0.05, "sine", 0.05, 1568, when); // D6 -> G6
      tone(1568, 0.08, "sine", 0.035, 1760, when + 0.04);
    },
    // Full-Stack fanfare — the moat. A rolled multi-source chord (different timbres
    // ascending) into a bright major lift + shimmer. "Quivly saw all of it."
    fullStack() {
      tone(mtof(72), 0.08, "sine", 0.05, mtof(76)); // CRM-ish lift
      SFX.coin(0.05); // Stripe cash
      tone(mtof(79), 0.09, "triangle", 0.05, mtof(83), 0.05); // Gong-ish
      tone(mtof(84), 0.1, "sine", 0.05, mtof(88), 0.1); // Zendesk-ish bell
      [0, 4, 7, 12].forEach((s, i) => tone(mtof(76 + s), 0.24, "triangle", 0.05, mtof(76 + s) * 1.5, 0.14 + i * 0.06));
      tone(mtof(96), 0.5, "sine", 0.025, mtof(108), 0.2); // shimmer tail
      noiseHit(0.0, 0.05, { hp: 2000, dur: 0.3, dest: sfxBus });
    },
    // Boss renewal-saved flourish — a short triumph + low impact (a mini-win).
    bossDown() {
      [0, 7, 12, 16].forEach((s, i) => tone(mtof(60 + s), 0.26, "triangle", 0.06, mtof(60 + s) * 1.5, i * 0.07));
      tone(70, 0.5, "sine", 0.06, 46); // low impact body
      noiseHit(0, 0.06, { hp: 800, dur: 0.4, dest: sfxBus });
    },
    // Boss (renewal Opportunity) arrives at the gate — ominous low riser.
    bossIncoming() {
      tone(mtof(36), 0.6, "sawtooth", 0.05, mtof(48));
      tone(mtof(43), 0.5, "triangle", 0.04, mtof(50), 0.1);
      noiseHit(0, 0.05, { hp: 600, dur: 0.5, dest: sfxBus });
    },
    // A pursuing churn signal neutralized — aggressive zap settling into a save.
    churnResolved() {
      tone(900, 0.06, "sawtooth", 0.05, 300); // threat zap down
      tone(mtof(64), 0.12, "triangle", 0.05, mtof(71), 0.05); // resolve up — saved
      noiseHit(0, 0.03, { hp: 3000, dur: 0.06, dest: sfxBus });
    },
    // Per-source sting via play("signal", "Stripe") (or no arg -> rotation).
    signal(source) {
      const idx = typeof source === "string" && SOURCES.indexOf(source) >= 0
        ? SOURCES.indexOf(source)
        : (srcCounter++) % SOURCES.length;
      signalSting(SOURCES[idx], 1, 0);
    },
    // Portfolio took damage: dark descending buzz.
    hurt(amount = 1) {
      const v = clamp(0.05 + amount * 0.01, 0.05, 0.11);
      tone(200, 0.26, "sawtooth", v, 80);
      tone(140, 0.22, "square", v * 0.6, 70);
    },
    // False positive on a healthy account: a "wrong" two-tone.
    error() {
      tone(330, 0.1, "square", 0.06, 247); // E4 -> B3
      tone(247, 0.16, "square", 0.05, 196, 0.08); // B3 -> G3
    },
    // Health warning (crossed below ~30): an urgent alarm wail (not catastrophic).
    warn() {
      tone(740, 0.12, "square", 0.05, 560);
      tone(560, 0.16, "square", 0.045, 740, 0.13); // wail back up = klaxon
    },
    // Critical health / Last Stand (below ~20): faster triple beep + low rumble.
    critical() {
      [0, 1, 2].forEach((i) => tone(880, 0.08, "square", 0.05, 660, i * 0.1));
      tone(60, 0.5, "sawtooth", 0.06, 40); // dread rumble
    },
    // Sustained heartbeat under critical health — a low "lub-dub".
    heartbeat() {
      tone(70, 0.1, "sine", 0.05, 50);
      tone(60, 0.12, "sine", 0.04, 44, 0.12);
    },
    // Renewal Day is here (final 20s, one-shot): a tension riser + deep impact.
    renewalDay() {
      tone(mtof(48), 0.8, "sawtooth", 0.045, mtof(60));
      tone(mtof(55), 0.7, "triangle", 0.035, mtof(64), 0.05);
      tone(55, 0.6, "sine", 0.05, 41); // deep impact
      noiseHit(0, 0.05, { hp: 1000, dur: 0.6, dest: sfxBus });
    },
    // Dash: quick upward air-swish.
    dash() {
      tone(280, 0.13, "sawtooth", 0.05, 620);
      noiseHit(0, 0.04, { hp: 2200, dur: 0.13, dest: sfxBus });
    },
    // Jump: light hop.
    jump() {
      tone(420, 0.1, "sine", 0.06, 760);
    },
    // Landing thud (scaled by impact).
    land(impact = 1) {
      const v = clamp(0.025 + Number(impact || 0) * 0.02, 0.025, 0.07);
      tone(120, 0.09, "sine", v, 70);
      noiseHit(0, v * 0.5, { hp: 320, dur: 0.08, dest: sfxBus });
    },
    // Near-miss: tense zip past the ear.
    nearmiss() {
      tone(720, 0.07, "sine", 0.04, 560);
      tone(760, 0.07, "sine", 0.025, 600); // slight detune for unease
    },
    // Combo escalation: pitch rises with the combo count.
    combo(n = 1) {
      const step = clamp(n, 1, 16);
      tone(660 + step * 60, 0.07, "triangle", 0.045, 990 + step * 70);
    },
    // Zone change: a soft brand sting + airy rise.
    zone() {
      tone(392, 0.18, "triangle", 0.05, 587); // G4 -> D5
      tone(587, 0.2, "sine", 0.035, 784, 0.06);
    },
    // Start: short power-on sting.
    start() {
      tone(196, 0.18, "sawtooth", 0.05, 392);
      tone(392, 0.16, "triangle", 0.04, 523, 0.06);
    },
    // Win: triumphant rising arpeggio + shimmer.
    win() {
      const seq = [0, 4, 7, 12, 16, 19, 24]; // major triumph from C5
      seq.forEach((s, i) => tone(mtof(60 + s), 0.22, "triangle", 0.06, mtof(60 + s) * 1.5, i * 0.085));
      tone(mtof(84), 0.6, "sine", 0.03, mtof(96), 0.6);
    },
    // Lose: heavy descending minor + a low thud.
    lose() {
      const seq = [0, -2, -3, -7]; // A4 sliding down
      seq.forEach((s, i) => tone(mtof(69 + s), 0.34, "sawtooth", 0.06, mtof(69 + s - 12), i * 0.17));
      tone(70, 0.7, "sine", 0.07, 45, 0.05);
    },
  };

  // --------------------------------------------------------------------------
  // Announcer barks — punchy vocal-ish stings (formant bark + accents). Distinct
  // voices for the headline moments. No samples; all synth.
  // --------------------------------------------------------------------------
  const BARK = {
    // "Whoaaa" — descending vocal that matches the bullet-time drop.
    shootdodge() {
      bark(440, [600, 1000], 0.42, 0.07, 150);
      tone(520, 0.4, "sine", 0.04, 120, 0, sfxBus);
      noiseHit(0, 0.05, { hp: 1100, dur: 0.4, dest: sfxBus });
    },
    // "Lo-co!" — two punchy rising syllables.
    loco() {
      bark(360, [500, 900], 0.12, 0.07, 420, 0); // "lo"
      bark(520, [700, 1500], 0.18, 0.075, 760, 0.13); // "co!"
      tone(1200, 0.05, "triangle", 0.03, 1700, 0.0, sfxBus);
    },
    // "OVERDOSE!" — huge: a stacked multi-formant vocal chord + sub drop + blast.
    overdose() {
      [330, 415, 500].forEach((f, i) => bark(f, [700, 1300], 0.5, 0.06, f * 1.4, i * 0.04));
      bark(620, [900, 1800], 0.55, 0.07, 1500, 0.1); // bright top
      tone(80, 0.7, "sawtooth", 0.07, 40, 0.0, sfxBus); // sub impact
      noiseHit(0, 0.08, { hp: 700, dur: 0.6, dest: sfxBus });
    },
    // "Full stack secured!" — triumphant double vocal stab + cash shimmer.
    fullStack() {
      bark(440, [650, 1200], 0.14, 0.06, 660, 0);
      bark(660, [800, 1600], 0.2, 0.06, 880, 0.12);
      SFX.coin(0.04);
    },
    // Generic announce (e.g. "Triple deploy!") — one clean rising vocal stab.
    generic() {
      bark(480, [700, 1300], 0.16, 0.06, 720, 0);
      tone(1400, 0.05, "triangle", 0.03, 1900, 0.02, sfxBus);
    },
  };

  // Dispatch a bus "announce" {text,tone} to the right bark by keyword.
  function announceSting(text) {
    resume();
    const s = String(text || "").toUpperCase();
    if (/SHOOT ?DODGE|DIVE/.test(s)) BARK.shootdodge();
    else if (/OVERDOSE/.test(s)) BARK.overdose();
    else if (/LOCO/.test(s)) BARK.loco();
    else if (/FULL ?STACK/.test(s)) BARK.fullStack();
    else BARK.generic();
  }

  // Short non-vocal stinger on a style RANK-UP (layers under the vocal bark when
  // both fire; provides feedback even if "announce" isn't wired). Bigger for OVERDOSE.
  function rankStinger(idx) {
    const base = 60 + idx * 4;
    [0, 4, 7].forEach((s, i) => tone(mtof(base + s), 0.09, "triangle", 0.045, mtof(base + s) * 1.5, i * 0.05, sfxBus));
    if (idx >= 3) { tone(mtof(96), 0.4, "sine", 0.03, mtof(108), 0.16, sfxBus); noiseHit(0, 0.05, { hp: 1500, dur: 0.3, dest: sfxBus }); }
  }

  // bus "style" {rank,mult,points}: hold the music intensity floor by rank; pop a
  // rank-up stinger on increase. Floor map: Cool .15 · Hot .4 · Loco .7 · OVERDOSE 1.
  const STYLE_FLOOR = [0.15, 0.4, 0.7, 1.0];
  const STYLE_RANKS = ["cool", "hot", "loco", "overdose"];
  function applyStyleAudio(e = {}) {
    let idx = STYLE_RANKS.indexOf(String(e.rank || "").toLowerCase());
    if (idx < 0) idx = 0;
    styleFloor = STYLE_FLOOR[idx];
    if (idx > styleRankIdx) { resume(); rankStinger(idx); }
    styleRankIdx = idx;
  }

  // play(name): resume + dispatch. Unknown names are a graceful no-op.
  function play(name, arg) {
    resume();
    const fn = SFX[name];
    if (typeof fn === "function") {
      try { fn(arg); } catch (_) {}
    }
  }

  // --------------------------------------------------------------------------
  // Music bed — beat scheduler on the audio clock ("two clocks" pattern).
  // --------------------------------------------------------------------------
  function startMusic() {
    if (music.running) return;
    const c = ensureCtx();
    if (!c) return;
    music.running = true;
    music.step = 0;
    music.nextTime = c.currentTime + 0.06;
    lastPaused = false; // let the fade-in stand; next frame corrects if actually paused
    if (musicBus) {
      musicBus.gain.cancelScheduledValues(c.currentTime);
      musicBus.gain.setValueAtTime(musicBus.gain.value, c.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.5, c.currentTime + 1.2); // fade in
    }
    scheduler();
  }

  function stopMusic(fade = 0.8) {
    if (!music.running) return;
    music.running = false;
    if (music.timer) { clearTimeout(music.timer); music.timer = null; }
    if (ac && musicBus) {
      const now = ac.currentTime;
      musicBus.gain.cancelScheduledValues(now);
      musicBus.gain.setValueAtTime(musicBus.gain.value, now);
      musicBus.gain.linearRampToValueAtTime(0.0, now + fade);
    }
  }

  function scheduler() {
    if (!music.running || disposed) return;
    if (ac && ac.state === "running") {
      // Schedule a little ahead of the playhead.
      while (music.nextTime < ac.currentTime + 0.2) {
        scheduleStep(music.step, music.nextTime);
        const bpm = 96 + intensity * 72; // 96..168 bpm
        music.nextTime += 60 / bpm / 4; // 16th notes
        music.step = (music.step + 1) % 16;
      }
    } else if (ac) {
      // Suspended (pre-gesture): hold the cursor at the playhead to avoid a burst.
      music.nextTime = ac.currentTime;
    }
    music.timer = setTimeout(scheduler, 25);
  }

  // One 16th-note slice. Layers gate in as intensity climbs.
  function scheduleStep(step, t) {
    const I = intensity;
    const onBeat = step % 4 === 0;
    const onEighth = step % 2 === 0;

    // Sub + bass pulse on every quarter (root, fifth at mid-bar).
    if (onBeat) {
      const fifth = step === 8 ? 7 : 0;
      tone(mtof(ROOT + fifth), 0.2, "triangle", 0.045 * (0.5 + 0.5 * I), null, 0, musicBus);
      tone(mtof(ROOT - 12), 0.24, "sine", 0.05 * (0.4 + 0.6 * I), null, 0, musicBus);
    }

    // Pad chord swell at the top of each bar once there's any heat.
    if (step === 0 && I > 0.12) {
      PAD.forEach((s) => pad(mtof(ROOT + 12 + s), 1.7, 0.03 * I, 0));
    }

    // Arpeggio enters mid-intensity; brighter + higher in the back half of the bar.
    if (I > 0.33) {
      const idx = step % PENT.length;
      const oct = step >= 8 ? 12 : 0;
      const type = I > 0.8 ? "sawtooth" : "square";
      tone(mtof(ROOT + 24 + PENT[idx] + oct), 0.11, type, 0.02 + 0.02 * I, null, 0, musicBus);
    }

    // Hats on the off-beats once it's driving.
    if (I > 0.45 && !onEighth) {
      noiseHit(0, 0.012 + 0.02 * I, { hp: 8000, dur: 0.035 });
    }

    // Renewal-day clock TICK on every quarter in the final stretch — a literal
    // countdown that hardens in the last 10s (renewalPhase 2). Tick-tock alternates.
    if (renewalPhase >= 1 && onBeat) {
      const tock = Math.floor(step / 4) % 2 === 1;
      const vol = renewalPhase >= 2 ? 0.05 : 0.025;
      tone(tock ? 2000 : 2600, 0.03, "square", vol, null, 0, musicBus);
    }

    // Renewal-day crescendo: urgent high lead doubling every 16th.
    if (I > 0.82) {
      const lead = (I - 0.82) / 0.18; // 0..1 across the top band
      tone(mtof(ROOT + 36 + PENT[step % PENT.length]), 0.08, "triangle", 0.014 * lead, null, 0, musicBus);
    }
  }

  // --------------------------------------------------------------------------
  // Per-frame: drive intensity from game.threat + final-20s crescendo, smooth it,
  // fire the renewal-day announcement + health warnings + heartbeat, duck on pause,
  // and auto start/stop the bed with the run. Single onFrame registration (contract).
  // --------------------------------------------------------------------------
  ctx?.onFrame?.((dt) => {
    if (disposed) return;
    const d = typeof dt === "number" && dt > 0 ? Math.min(dt, 0.1) : 0.016;

    // Round-transition detector: reset one-shots whenever a new run starts.
    if (game) {
      if (game.status === "running" && prevStatus !== "running") resetRoundOneShots();
      prevStatus = game.status;
    }

    // Auto intensity target from churn threat (0..100), combo energy, and the
    // renewal-day crescendo. renewalPhase mirrors the timer for the clock tick.
    let auto = 0;
    renewalPhase = 0;
    if (game) {
      auto = clamp((game.threat || 0) / 100, 0, 1) * 0.85;
      const comboFloor = clamp((game.combo || 0) / 12, 0, 1) * 0.35; // sustained energy on streaks
      auto = Math.max(auto, comboFloor);
      const tl = game.timeLeft;
      const status = game.status;
      const live = status === "running" || status == null;
      if (typeof tl === "number" && live && tl > 0) {
        if (tl <= 20000) {
          renewalPhase = tl <= 10000 ? 2 : 1;
          const prog = 1 - clamp(tl, 0, 20000) / 20000; // 0..1 as time runs out
          auto = Math.max(auto, 0.55 + prog * 0.45); // 0.55 -> 1.0
          if (!renewalAnnounced) { renewalAnnounced = true; play("renewalDay"); }
        }
      }
    }

    // Decay the event-reactivity bump.
    bump = Math.max(0, bump - d * 1.4);

    // Style rank holds an intensity floor (calmer at Cool, driving at OVERDOSE).
    const target = Math.max(auto, manualLevel, bump, styleFloor);
    // Critically-damped-ish approach.
    intensity += (target - intensity) * (1 - Math.exp(-d * 3));
    intensity = clamp(intensity, 0, 1);

    // Auto start/stop the bed alongside the run (robust if "start" never fires).
    // Gate start on the contract's round-active flag so the bed doesn't wake in a
    // lobby (game.status is "running" from construction); fall back to status.
    let running = false;
    if (game) {
      running = ctx?.state && hasFn(ctx.state, "running") ? !!ctx.state.running() : game.status === "running";
      if (running && game.status === "running" && !music.running) startMusic();
      if ((game.status === "won" || game.status === "lost") && music.running) stopMusic();
    }

    // Health warnings (hysteresis so they fire once per threshold crossing) +
    // a sustained heartbeat under critical health. Only while the round is live.
    if (game && running && game.status === "running") {
      const hp = typeof game.health === "number" ? game.health : 100;
      if (hp < 20 && !critWarned) { critWarned = true; lowWarned = true; play("critical"); }
      else if (hp < 30 && !lowWarned) { lowWarned = true; play("warn"); }
      if (hp > 35) lowWarned = false;
      if (hp > 25) critWarned = false;

      if (hp <= 20 && !isPaused()) {
        hbT += d;
        if (hbT >= 0.95) { hbT = 0; play("heartbeat"); }
      } else {
        hbT = 0;
      }
    }

    // Duck the music bus on pause — but ONLY on a pause/unpause transition, so we
    // never clobber startMusic()'s fade-in or churn the param every frame.
    if (ac && musicBus && music.running) {
      const paused = isPaused();
      if (paused !== lastPaused) {
        lastPaused = paused;
        const now = ac.currentTime;
        const cur = musicBus.gain.value;
        musicBus.gain.cancelScheduledValues(now);
        musicBus.gain.setValueAtTime(cur, now);
        musicBus.gain.linearRampToValueAtTime(paused ? 0.08 : 0.5, now + 0.25);
      }
    }
  });

  function resetRoundOneShots() {
    lowWarned = false;
    critWarned = false;
    renewalAnnounced = false;
    hbT = 0;
    srcCounter = 0;
    styleFloor = 0;
    styleRankIdx = -1;
  }

  function hasFn(o, k) {
    return o && typeof o[k] === "function";
  }

  function isPaused() {
    const s = ctx?.state;
    if (!s) return false;
    try {
      return typeof s.paused === "function" ? !!s.paused() : !!s.paused;
    } catch (_) {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Bus wiring. Handlers are stored so dispose() can detach when supported.
  // --------------------------------------------------------------------------
  const handlers = [];
  function on(name, fn) {
    if (!bus?.on) return;
    bus.on(name, fn);
    handlers.push([name, fn]);
  }

  on("start", () => { resume(); play("start"); startMusic(); });
  on("fire", () => play("fire"));
  on("pulse", () => { play("pulse"); kick(0.25); });
  // Neutralize → per-source / per-tier reward read. Bigger bump for stacked cards.
  on("kill", (p) => {
    resolveKill(p);
    const kind = p?.kind;
    kick(kind === "boss" ? 0.6 : kind === "shielded" ? 0.45 : kind === "elite" ? 0.36 : 0.3);
  });
  on("coin", () => play("coin"));
  on("combo", (p) => { play("combo", p?.combo); kick(0.18 + clamp((p?.combo || 0) / 12, 0, 0.35)); });
  on("escape", (p) => { play("hurt", 1 + (p?.severity || 0)); kick(0.4); });
  on("hitHealthy", () => { play("error"); kick(0.2); });
  on("hurt", (p) => { play("hurt", p?.amount || 1); });
  on("zone", () => play("zone"));
  on("dash", () => play("dash"));
  on("jump", () => play("jump"));
  on("land", (p) => play("land", p?.impact));
  on("nearmiss", () => play("nearmiss"));
  on("near-miss", () => play("nearmiss"));
  on("boss", (p) => { if (p?.active) { play("bossIncoming"); kick(0.5); } });
  on("win", () => { stopMusic(0.4); play("win"); });
  on("lose", () => { stopMusic(0.4); play("lose"); });

  // Total Overdose juice (combat/controller seam).
  on("announce", (p) => { announceSting(p?.text); kick(0.3); }); // {text,tone} -> vocal bark
  on("style", (p) => { applyStyleAudio(p); }); // {rank,mult,points} -> music floor + rank-up stinger
  on("dive", () => { play("diveWhoosh"); kick(0.25); }); // shootdodge launch -> slow-mo whoosh

  // Event reactivity: a fast, decaying intensity bump so the bed reacts to action.
  function kick(amount) {
    bump = clamp(Math.max(bump, amount), 0, 1);
  }

  // --------------------------------------------------------------------------
  // Resume AudioContext on the first user gesture (autoplay policy).
  // --------------------------------------------------------------------------
  const gestureEvents = ["pointerdown", "keydown", "touchstart", "mousedown", "click"];
  function onGesture() {
    resume();
    detachGestures();
  }
  function detachGestures() {
    if (typeof window === "undefined") return;
    for (const e of gestureEvents) window.removeEventListener(e, onGesture, true);
  }
  if (typeof window !== "undefined") {
    for (const e of gestureEvents) window.addEventListener(e, onGesture, true);
  }

  // --------------------------------------------------------------------------
  // Public API.
  // --------------------------------------------------------------------------
  return {
    play,
    // Held manual intensity floor (0..1); ambient threat/crescendo still apply on top.
    setIntensity(x) {
      manualLevel = clamp(Number(x) || 0, 0, 1);
    },
    get intensity() { return intensity; },
    resume,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopMusic(0.05);
      if (music.timer) { clearTimeout(music.timer); music.timer = null; }
      music.running = false;
      detachGestures();
      if (bus?.off) {
        for (const [name, fn] of handlers) { try { bus.off(name, fn); } catch (_) {} }
      }
      handlers.length = 0;
      if (ac && ac.state !== "closed") {
        try { ac.close(); } catch (_) {}
      }
      ac = master = sfxBus = musicBus = noise = null;
    },
  };
}