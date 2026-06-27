# Renewal Rush

A short (~90s) Unreal Engine 5.8 marketing micro-game for [Quivly.ai](https://www.quivly.ai) — deploy AI agents to save at-risk accounts before renewal day.

Built on the UE First Person / Arena Shooter template, reskinned for a premium dark SaaS aesthetic (Agent Pulse, no rifle fantasy).

## Requirements

- **Unreal Engine 5.8** (`/Users/Shared/Epic Games/UE_5.8/`)
- **macOS** with Xcode + Metal toolchain
- Plugins enabled in `MyProject.uproject`: `ModelContextProtocol`, `MCPClientToolset`, `EditorToolset`

## Quick start

1. Open `MyProject.uproject` in Unreal Editor 5.8
2. Open level `Content/Variant_Shooter/Lvl_ArenaShooter`
3. Press **Play** — 90s renewal rush loop (WIP)

### Game Lab (collaborative hub)

```bash
cd game-lab
./start.sh
# → http://127.0.0.1:3847
```

Living docs: `game-lab/data/game-script.json`, `studio-state.json`, lessons, glossary.

### Unreal MCP (AI editor control)

MCP auto-starts on port **8000** (`Config/DefaultEditorPerProjectUserSettings.ini`).

```bash
# From project root
grok mcp doctor unreal-mcp

# Reskin / polish via MCP scripts
python3 game-lab/mcp/run_reskin.py
python3 game-lab/mcp/run_polish.py
```

## Project layout

| Path | Purpose |
|------|---------|
| `Content/Variant_Shooter/` | Arena level, shooter blueprints, UI |
| `game-lab/` | Web hub + JSON living documents + MCP scripts |
| `Config/` | Engine/project settings incl. MCP auto-start |
| `game-lab/data/game-script.json` | Renewal Rush creative + brand spec |

## Status

- Lesson 1: Press Play ✓
- Lesson 2: MCP arena polish (Quivly lighting, fog, PPV, weapons hidden) ✓
- Lesson 3: Agent Pulse beam + account orbs — next

## License

Proprietary — Quivly.ai internal / marketing use.