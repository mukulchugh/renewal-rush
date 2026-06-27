# Renewal Rush — Single Source of Truth (integration plane)

One doc that fuses every parallel module. All builder agents conform to the **Contract**;
integration follows the **Init order**; status lives in the **Module registry**. If a module
and this doc disagree, **this doc wins** — fix the module.

**Game:** Quivly's embeddable browser FPS. You are a deployed Quivly AI agent — laser-deploy
agents onto churn **signals** to save at-risk accounts before a 90s **renewal** timer. Premium
dark-SaaS, indigo neon, adrenaline + surprise. Stack: **Vite + Babylon.js 8.56**, `game-lab/app/`.

**Bundle (integrated build):** 422KB gz first paint / 566KB gz absolute ceiling across 123 chunks
(target ≤800KB) — comfortably under. `bun run build` green · `bun test` 8/8 green.
**Pending:** GPU-browser playtest (visual/feel) — headless Chrome can't create a WebGL context.

---

## Contract (every `src/<name>.js` obeys this)

- Babylon 8.56 via `@babylonjs/core` **deep ESM imports only** (never the barrel). See `BABYLON-IMPORTS` below.
- Each module exports ONE factory: `export function create<Name>(ctx) { …; return api }`.
- Per-frame work is registered **inside** the factory via `ctx.onFrame(fn)` — `fn(dtSeconds)`.
- `ctx = { engine, scene, camera, canvas, game, bus, onFrame, state, fx }`
  - `camera` — the player `FreeCamera` (main.js creates it before modules).
  - `game` — `Game` instance from `./game.js` (pure loop; numbers come from here).
  - `bus` — `bus.on(name, fn)` / `bus.emit(name, payload)`.
  - `state` — shared flags: `running`, `locked` (pointer lock), `paused`, `timeScale` (fx hit-stop multiplies dt).
  - `fx` — set by `fx.js`: `{ shake(amt), hitStop(sec), flash(color) }` (others optional-chain it).
- **Standard bus events:** `start` · `fire` · `pulse` · `kill {arr,kind,position}` · `escape {severity}` · `hitHealthy` · `hurt {amount}` · `combo {combo}` · `zone {name}` · `win` · `lose`.
- **Enemy ↔ combat seam:** enemy meshes set `mesh.metadata = { kind:"signal"|"healthy"|"churn"|"boss", chips, onHit(damage)->dead:boolean }`. `combat` only raycasts + calls `metadata.onHit`.

## Module registry  (status: ⬜ pending · 🔧 building · ✅ integrated & building green · ▶ playtested)

| Module | File | Phase | Responsibility | Status |
|--------|------|-------|----------------|--------|
| game | `src/game.js` | 1 | Pure meta loop (timer/health/threat/ARR/combo/rank). Engine-agnostic, node-testable. | ✅ |
| controller | `src/controller.js` | 1 | Free-movement FPS (WASD + unclamped look + jump/dash/rush). Replaces lane-rail. | ✅ |
| combat | `src/combat.js` | 1+3 | Agent Pulse: raycast fire + tracer + AoE pulse + recoil/muzzle. | ✅ |
| enemies | `src/enemies.js` | 3 | Signal/elite/shielded/churn(pursue AI)/boss spawning + escape + healthy decoys. | ✅ |
| fx | `src/fx.js` | 2 | DefaultRenderingPipeline (bloom/FXAA/vignette/CA) + SSAO2 + GlowLayer + shake/hit-stop. | ✅ |
| world | `src/world.js` | 4 | Open-feeling arena: ground, skybox, Renewal Gate landmark, 4 branching funnel sectors. | ✅ |
| audio | `src/audio.js` | 3 | WebAudio SFX (fixed pitch-slide) + intensity-gated music + renewal crescendo. | ✅ |
| hud | `src/hud.js` | 1+5 | On-brand HTML/CSS HUD bound to `game` + floaters/callouts/crosshair. | ✅ |
| brand | `src/brand.js` | 5 | Signal-card meshes (source glyphs), share result card, quivly.ai CTA, ranks. | ✅ |
| main | `src/main.js` | — | Integrator: engine/scene/camera, bus, onFrame registry, dt*timeScale loop, wires all. | ✅ |

## Init order (main.js)
`fx` (pipeline first) → `world` → `audio` → `hud` → `enemies` → `combat` → `controller` → `start`.
(Pipeline before meshes; controller last so it owns the camera each frame; shake applied after.)

## Commands
```bash
cd game-lab/app && bun install
bun dev            # hot-reload dev
bun run build      # embeddable dist/ (watch gz size vs 800KB)
bun test           # node --test headless logic (game.js)
```

## BABYLON-IMPORTS (verified to build under Vite)
`engine`·`scene`·`Cameras/freeCamera`·`Maths/math.vector {Vector3,Matrix}`·`Maths/math.color {Color3,Color4}`·
`Meshes/meshBuilder`·`Materials/standardMaterial`·`Materials/PBR/pbrMaterial`·`Materials/Textures/{texture,dynamicTexture}`·
`Lights/{directionalLight,hemisphericLight}`·`Lights/Shadows/shadowGenerator` (+`…/shadowGeneratorSceneComponent` side-effect)·
`PostProcesses/RenderPipeline/Pipelines/{defaultRenderingPipeline,ssao2RenderingPipeline}`·`Layers/glowLayer`·
`Particles/particleSystem`·`Culling/ray {Ray}`·`Loading/sceneLoader {ImportMeshAsync}` (+`@babylonjs/loaders/glTF`).
