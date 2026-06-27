# Renewal Rush — Grok Build loop contract

This project uses **loop engineering**: the agent designs work as repeatable cycles (discover → plan → execute → verify) instead of one-shot prompts.

## Platform (locked)

**Ship on the web.** Renewal Rush is a browser game — embeddable on quivly.ai, shareable via URL, zero install.

| Layer | Path | Role |
|-------|------|------|
| **Primary** | `game-lab/renewal-rush-3d.html` | Three.js FPS — full gameplay loop |
| **Fallback** | `game-lab/renewal-rush.html` | 2D Signal Triage board |
| **Distribution** | Game Lab server → quivly.ai embed | Marketing / conferences / social |
| **Unreal** | `Lvl_ArenaShooter` | Learning sandbox only — not the ship target |

Do not spend cycles on Unreal Blueprint gameplay unless the user explicitly pivots back.

## Default behavior (always)

When the user asks you to build, fix, or continue work:

1. **Read state first** — `game-lab/data/studio-state.json`, `game-lab/data/game-script.json`, `game-lab/data/activity-log.json`
2. **Pick the right loop** (see table below) — do not wait for the user to say "/goal" or "/loop"
3. **Define "done" in measurable terms** before executing
4. **Execute** in `game-lab/` (HTML/JS/CSS) — not Unreal
5. **Verify** — structural test, browser play check, 60fps feel on interaction
6. **Update artifacts** — `studio-state.json`, `activity-log.json`
7. **Continue the loop** until done, blocked, or the user stops you

## Which loop to use

| Situation | Use |
|-----------|-----|
| Multi-step feature until complete | `/goal <objective with DONE WHEN criteria>` |
| Gameplay polish / feel | Edit `renewal-rush-3d.html` directly |
| Code change with review gate | `/implement` or `/check-work` |
| Unreal visual experiment (optional) | MCP `game-lab/mcp/run_*.py` — only if user asks |

## Active project goal (default until shipped)

**Renewal Rush web gameplay** — smoothest, highest-quality browser experience:

- 90s renewal loop with stack connect → surface signals → deploy Agent Pulse
- Smooth WASD + mouse look (acceleration, hover feedback, juice)
- ARR scoring, chip multipliers, portfolio health
- Quivly dark SaaS look (indigo `#6366F1`, emissive orbs, audio feedback)
- Embeddable, mobile-aware title screen (desktop-first controls)

**Done when:** `renewal-rush-3d.html` plays smoothly end-to-end, validation test passes, ready to embed on quivly.ai.

## Verifier rules (non-negotiable)

- Never claim success without evidence (validation test, play confirmation)
- Weak verifiers produce motion without progress — pin checks up front
- After each pass, append one line to `game-lab/data/activity-log.json`

## Paths

- Game Lab UI: `game-lab/` (run `python3 game-lab/server.py` → http://127.0.0.1:3847)
- Play: http://127.0.0.1:3847/renewal-rush-3d.html
- Unreal project (sandbox): `/Users/mukulchugh/Documents/Unreal Projects/MyProject`