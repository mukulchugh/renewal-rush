# Renewal Rush — Game Design Spec (loop, economy, difficulty, stickiness)

Decisions are final; build to these numbers. Pairs with ARCHITECTURE.md (wiring) +
QUIVLY-GROUNDING.md (theme). Goal: a 90s embeddable hook that is FUN on the first try,
teaches Quivly's thesis through its incentives, and is sticky (replays + shares + CTA clicks).

## 0. Combat model v2 — armed smart agents (supersedes the "don't-shoot-healthy" rule)
The game is a tactical arena shooter with a Quivly skin. Enemies are SMART, ARMED AI agents.
- **Enemies = armed churn-AI agents** (the avatar humanoids): real-time bot AI (perception →
  utility/behavior-tree decisions → steering): chase, FLANK, take COVER behind city geometry,
  peek-and-shoot, retreat when low, regroup. 10-15 active. Tiers (Critical/High/Medium) = how
  aggressive/accurate/tanky, NOT a "don't shoot" flag.
- **They carry RANGED WEAPONS.** They shoot YOU (hitscan/projectile → emit "hurt" {amount} →
  health ↓) AND lay SIEGE to ACCOUNTS (the parody-company buildings) → that account's health ↓;
  an account at 0 CHURNS (portfolio health ↓ + threat ↑ + ARR at risk). Telegraph shots (muzzle
  flash + tracer + a brief aim line) so they're dodgeable — take cover.
- **DROP the healthy-account / false-positive penalty entirely.** Accounts are FRIENDLY structures
  you DEFEND — you cannot damage them; there is no green "don't-shoot" enemy. Every hostile on
  screen is a valid target. (game.hitHealthy stays in game.js but is no longer triggered.)
- **Player + (optional later) allied Quivly agents** vs the rival churn-agent squad, fought across
  the bounded city map. Strategy = pick which high-ARR accounts to defend, which agents to drop
  first, when to push vs hold cover, manage your health.
- **Health** = one bar (portfolio health). Drained by enemy fire on you + by accounts being
  besieged. 0 = lose (churned). ARR Saved (score) comes from neutralizing agents + surviving the
  renewal with accounts intact. Avatars still die with the procedural ragdoll (4 styles).
- **AI tech = real-time game AI, NOT an LLM** (LLM = too slow per-frame + breaks the light embed).
  Dynamic banter via state-keyed callout pools ("Stribe's going dark!", "Flanking left").

## 0b. Style direction — "Total Overdose" over-the-top arcade vibe
Feel target: Total Overdose / Max Payne — stylish, explosive, adrenaline arcade gunplay. Crank STYLE + JUICE.
- **SHOOTDODGE DIVE** — THE signature move (Max Payne / Total Overdose). Build to these exact physics; the
  feel lives in the details below, not in "add slowmo":
  1. **Ballistic launch, not a dash.** On trigger (Shift, or double-tap a strafe dir) set an airborne state with
     an initial velocity = moveDir × launchSpeed (~14-18 u/s) + up × launchUp (~5-6 u/s). Each frame integrate
     vel.y -= g·dt and position += vel·dt — a real projectile ARC through the air. Player has no ground control
     mid-dive (committed leap). Lasts until the body returns to eye-height ground (~0.7-1.0s of game time).
  2. **THE CRUX — slow-mo is DECOUPLED from aim.** The world drops to deep slow-mo (state.timeScale ~0.18-0.25;
     fx owns it → game.tick, enemy movement, enemy bullets all crawl) BUT mouse-look + the dive trajectory +
     your firing run at REAL wall-clock rate. So you whip the camera and place shots at full speed while bullets
     hang in the air. (Controller look already reads raw pointer-lock deltas, not dt — keep it that way; the
     DIVE integration must also use REAL dt, not dt·timeScale, or the arc would crawl too. Only the WORLD sim is
     slowed.) This decoupling is the entire power fantasy — get it right.
  3. **Fire continuously mid-air.** Combat must NOT gate firing while airborne/diving — unloading mid-dive is the
     point. Air kills + multi-kills during one dive = big STYLE bonus.
  4. **Landing recovery.** On ground-contact: a prone/get-up beat (~0.35s) where time ramps back to 1.0 and you
     are slower + vulnerable (can't instantly re-dive) — the risk that balances the reward. Land thud + dust +
     camera dip.
  5. **Camera = the body.** FPS camera arcs along the ballistic path (you see the world tilt/rise/fall), a roll
     toward dive direction (~8-12°), FOV widens on launch and eases back on land. Motion trail/streak + a whoosh
     + world-audio pitch-drop during slow-mo.
  6. **Economy.** Costs a chunk of the FOCUS meter (fills from kills/style) so it's earned + paced, not held.
     i-frames (state.invuln) for the airborne portion, dropped during landing recovery.
  Net: leap sideways through a hail of telegraphed agent fire, time crawls, you calmly place 3 headshots, ragdolls
  blast apart, you slam down — that exact sequence is the bar.
- **Focus / bullet-time** (the meter behind the dive): a FOCUS meter fills from kills + style; powers the
  dive and an optional stationary "tap to slow time" focus. Generalize the existing Last-Stand slow-mo into
  this one player-triggered meter (fx owns state.timeScale; restores cleanly).
- **Style / "Loco" meter**: rapid + varied + stylish kills (mid-air, dash/slide kills, Full-Stack multi-source,
  long range, no-damage streak) build a STYLE rank Cool→Hot→Loco→OVERDOSE that MULTIPLIES ARR and decays if you
  stop. Big animated +ARR popups, floating hit numbers, screen punch on rank-ups.
- **Explosive ragdoll chaos**: crank ragdoll impulse + debris + sparks; the AoE "pulse" deploy is explosive with
  chain reactions. Over-the-top, not subtle.
- **Stunt shooting**: you can fire while dashing/sliding/jumping; air + slide kills grant bonus style.
- **Vibrant sun-drenched palette**: saturated, warm, punchy daylight (NOT washed). Push saturation/contrast +
  warm key light + vivid accents — this also fixes the "washed out" complaint.
- **Adrenaline audio + announcer**: driving music that intensifies with style; an announcer barks combos
  ("Loco!", "OVERDOSE!", "Triple deploy!"), Quivly-flavored where it fits ("Full stack secured!").
- Stays Quivly-skinned, but leans into arcade FUN.
- Implementation pass (AFTER the armed bots land, tuned against the live firefight): fx (focus/slowmo + juice +
  saturation), controller (dive/slide-shoot + focus trigger), combat (style meter + stylish-kill detection +
  explosive feel), hud (style/focus meters + big popups + announcer line), audio (announcer + intensity music).

## 1. Session structure (two acts)
- **Act 1 — Renewal Day (0–90s):** the core marketing round. Survive to renewal with health ≥ 40
  → **WIN** ("renewal closed-won"). This is the clean, shareable success moment.
- **Act 2 — Overtime / Expansion Run (90s+):** OPTIONAL endless survival that starts on win.
  Difficulty keeps ramping; you chase ARR until health = 0. This is the "how long can you last"
  score chase + leaderboard fuel. Lose in Act 1 (health 0) ends the run immediately.
- Final 20s of Act 1 = **Renewal Day crescendo**: tempo up, spawn surge, red closing vignette.

## 2. Economy / incentive math (game.js — keep pure + node-tested)
Score = **ARR Saved** ($). Per-signal payout:

    arr = BUCKET_ARR[bucket] * fullStackMult(sources) * comboMult(combo) * directorScale

- **BUCKET_ARR** (riskier saves pay more): Critical 800 · High 500 · Medium 280. (Healthy = not a target.)
- **fullStackMult(sources)** = 1 + 0.5*(sources-1)  → 1 src ×1.0, 2 ×1.5, 3 ×2.0. THE strategic core
  (connecting the stack pays — Quivly's moat). `chips` passed to deploySignal = source count.
- **comboMult**: tiers at combo 3→2×, 6→3×, 10→5× (keep existing multiplierFor).
- **champion_departure**: ×2 ARR AND, if it escapes, 2× the normal health/threat penalty (must-catch).
- **Escape penalty** (signal reaches/expires): combo→0, health −(6..14 by bucket), threat +.
- **False positive** (hit Healthy 75–100): combo→0, health −8 (target discrimination skill).
- **Health**: start 100, cap 100. Catches heal small (+1..+3, more for Full Stack). Win needs ≥40.
- **Threat** 0–100: rises on escapes, decays slowly on catches; feeds the director + environment.
- Keep deploySignal({ baseArr, chips }) signature; implement bucket+fullstack+combo INSIDE game.js
  (enemies passes baseArr=BUCKET_ARR[bucket], chips=sources). Update test/game.test.js, keep green.

## 3. Difficulty director (enemies.js)
- **tension** = f(elapsed, threat, combo). Spawn interval and enemy hp/speed scale with tension.
- Enemy mix by sector: Connect (mostly single-source easy), See (more sources appear), Score
  (Full Stack + seekers), Act (critical + boss). Overtime: tension keeps climbing, no cap.
- **Seekers** (Critical/High) pursue + deal contact damage; telegraph (wind-up flash) → dodge window.
- **Boss** = a Critical renewal account at the Renewal Gate near 90s; defeating = win flourish.
- **Mutators** (1 per run, announced at start): Black Friday Surge (2× spawns, 1.3× ARR),
  Budget Freeze (slower pulse, +ARR), Exec Escalation (champion_departure storm), Quiet Quarter
  (fewer but tankier). Adds surprise + replay variety.

## 4. Meta / stickiness (NEW meta.js + hud.js)
- **Best + mini-leaderboard** in localStorage (top 5 ARR + rank). Show "Best: $X" on title/end.
- **Daily seed**: deterministic run keyed off the date (passed in via ctx, no Date.now in game.js).
  Same seed = same mutator + spawn pattern → "beat my run" sharing. Toggle: Daily vs Endless.
- **Shareable result card**: render run stats (ARR, rank, deploys, Full Stack catches) to a branded
  canvas → image; navigator.share on mobile, copy-to-clipboard + download on desktop. Carries the
  quivly.ai CTA. This is the viral + CTA loop (brand.js builds the card visual).
- **Upgrade draft (roguelite)**: at each sector boundary, pause + offer **1 of 3** Quivly-themed
  upgrades; pick applies a modifier for the rest of the run. Pool (themed): Webhook (+pulse rate),
  Data Lake (+15% ARR), Auto-Renew (heal on Full Stack), Sentiment Engine (slow nearby seekers),
  Forecast (see next spawn), Playbook→Skill (AoE radius+). Run-to-run variety = replayability.
- **Ranks** by ARR: Renewal Rookie < $5k · Account Defender < $15k · CSM Speedrunner < $40k ·
  VP Retention < $80k · Chief Renewal Officer ≥ $80k. HUD shows "next rank in $X".
- **Last Stand**: at health ≤ 20, trigger ~2s slow-mo "Focus" (state.timeScale) once per run +
  a comeback heal if you land 3 catches in the window. Clutch moment = memorable.

## 5. Fun / first-time-user (embeddable = strangers play once)
- 10s hook: instant action on click, NO tutorial wall; controls as fading on-screen hints.
- Readability: enemies colored by bucket (Critical red→Healthy green), champion_departure + Full
  Stack visually flagged, crosshair turns hostile-red over valid targets, green over healthy.
- Juice scales with payoff: big hit-stop + flash + ARR popup on Full Stack / Critical / boss.
- Fail is still rewarding: result card shows ARR saved + rank + "one more run" + CTA.

## Build priority
P0: game.js economy+overtime+ranks (+tests), enemies director+seekers+buckets, hud readouts, world buildings.
P1: meta.js (best/seed/share/draft/last-stand), brand result card, mutators, weapon viewmodel.
P2: extra mutators, leaderboard polish, audio crescendo layers.
