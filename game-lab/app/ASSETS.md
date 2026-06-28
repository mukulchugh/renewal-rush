# Asset sourcing guide — Renewal Rush

Curated, **license-safe** sources for pushing the look toward AAA without breaking the
embeddable bundle budget. Scope: this is an **urban FPS** (Times Square plaza, boulevard,
glass towers, cars, soldier-style agents). Every asset below is **CC0 or CC-BY** — never
ship un-licensed GitHub GLBs into a Quivly product.

## Budget — read before adding anything

- **JS bundle ceiling: ≤800 KB gz** (ARCHITECTURE.md). Currently ~667 KB gz first chunk. New
  *runtime* GLB/HDR/texture assets live in `public/` and do **not** hit the JS budget, but they
  **do** hit first-load wall-clock. Treat ~6 MB total runtime assets as the soft ceiling.
- Compress GLBs with **Draco** (`gltf-transform optimize --compress draco`) → 3–10× smaller.
- Compress textures to **KTX2/Basis** (`gltf-transform etc1s` or `uastc`) → smaller VRAM + GPU
  upload. Note (from memory): KTX2 helps **VRAM, not FPS** here — the scene is GPU-fill-bound.
- HDRIs: a **1K** equirect `.hdr` (~1.5 MB) is plenty for IBL; **2K+** (4 MB+) is wasted bytes
  unless the sky is directly visible at high res.

## Current inventory (`public/`)

| File | Size | Role | Notes |
|------|------|------|-------|
| `models/soldier.glb` | 1.5 MB | primary human (player + enemies) | first in `HUMAN_MODELS` (main.js) |
| `models/xbot.glb` | 3.6 MB | fallback human (Mixamo X Bot) | only downloads if soldier fails — keep, but **Draco it** |
| `models/human.glb` | 428 KB | 2nd fallback | fine |
| `models/gun.glb` | 131 KB | rifle viewmodel | Quaternius CC0 |
| `models/sky.hdr` | 4.2 MB | **active** IBL + skybox (`assets.js` `ENV_URL`) | 2K — a 1K recompress halves first-load |
| ~~`assets/env/potsdamer_platz_1k.hdr`~~ | ~~1.5 MB~~ | **REMOVED** (was orphaned dead weight) | replaced by `sky.hdr` long ago; deleted to cut `dist/` by 1.5 MB |
| `assets/*` (ambientCG PBR sets) | — | ground/facade/asphalt/brick | CC0, already wired via Track B (`assets.js`) |

**Action items found:** delete the orphaned `potsdamer_platz_1k.hdr`; Draco-compress `xbot.glb`;
consider a 1K recompress of `sky.hdr`.

## Best CC0 / CC-BY sources (verified, license-safe)

### Characters & weapons (rigged GLB)
- **Quaternius** — https://quaternius.com — CC0. Ultimate Modular Men/Women, weapon packs,
  vehicles. Already the source of `gun.glb`. Best match for a stylized-but-clean AAA look that
  stays light. **Start here for new agent/enemy variants.**
- **Kenney** — https://kenney.nl/assets?q=3d — CC0. Blaster Kit (weapons), City Kit, Car Kit,
  Mini Characters. Uniform low-poly style, tiny files — ideal for crowd/ambient density.
- **Mixamo** — https://mixamo.com — free w/ Adobe account (not CC0, but free for use). The
  current `xbot.glb` is from here. Use it for **animations** (idle/run/aim/death) retargeted onto
  Quaternius/Kenney rigs. This is the cheapest path to "GTA-like" locomotion + combat anims.
- **3dmodelscc0** (itch.io) — https://3dmodelscc0.itch.io — CC0 guns/explosives packs.

### Environment — HDRI / skybox / PBR textures
- **Poly Haven** — https://polyhaven.com/hdris — CC0, no attribution, no signup. For a night-city
  vibe see **night/skies** categories (e.g. `satara_night`). Download 1K `.hdr`, drop in
  `public/models/`, point `assets.js` `ENV_URL` at it. IBL + reflections update together.
- **ambientCG** — https://ambientcg.com — CC0 PBR. Already the source of the asphalt/brick/concrete
  sets. Grab matching **Metal**, **Glass**, **Road markings** for the boulevard.
- **Poly Haven textures/models** — https://polyhaven.com/textures — CC0 props (street furniture,
  barriers, signage) to dress the plaza.

### Reference Babylon.js FPS projects (for GTA-like / combat patterns — study, don't copy assets)
- **BabylonJS/Assets** — https://github.com/BabylonJS/Assets — official public-domain asset repo
  (weapons: frostAxe, runeSword; characters). Safe to pull GLBs directly.
- **ssatguru/BabylonJS-CharacterController** — https://github.com/ssatguru/BabylonJS-CharacterController
  — animation state machine for rigged FP/TP characters (idle/run/jump/shoot blending). Good
  reference for wiring soldier.glb animation groups to the existing controller.
- **gamedev44/FPS-ENGINE-BAB.JS** — https://github.com/gamedev44/FPS-ENGINE-BAB.JS — weapon recoil,
  aim, grenades/explosions patterns.
- **renjianfeng/BabylonFpsDemo** / **yamayuski/babylon-fps-shooter** — full FPS samples (Vite).
- **awesome-babylonjs** — https://github.com/Symbitic/awesome-babylonjs — curated index for more.

## Integration seams (where assets plug in)

- **Humans:** `src/main.js` → `HUMAN_MODELS = ["/models/soldier.glb", …]` (first that loads wins).
  Add a new rigged GLB here; `spawnHuman()` in `humanavatar.js` consumes it.
- **Gun:** `src/main.js` → `ctx.gunAsset = LoadAssetContainerAsync("/models/gun.glb")`.
- **Environment/IBL:** `src/assets.js` → `ENV_URL`. One `.hdr` drives both skybox + reflections.
- **Ground/wall PBR:** `src/assets.js` Track B (ambientCG sets).
- **Ambient cars:** `src/ambient.js` consumes `public/models/cars/`.

## Animation note (the highest-leverage "AAA feel" win)

`soldier.glb`'s value is mostly its **animation groups**. If it has idle/run/aim/fire/death clips,
wire them through the controller/enemy state machines (see ssatguru reference). Static-pose humans
read as cheap; locomotion + hit reactions read as AAA. This needs a GPU playtest to tune blend
timings — queued below, not changeable headless.
