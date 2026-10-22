# Roadmap

What Chiptune Studio still lacks, found while VN Studio and the creative hub (`C:\projects\Personal\creative-hub`) drove it over MCP (2026-10-20, the pixel-art book *The Soother That Fell into Dragon Land*). Moved here from the hub's `ROADMAP.md` on 2026-10-22. Finished work is in `.claude/tickets/` (MDI-03 headless MCP, `compose_track` and `render_audio` for VN Studio; MDI-05 `CHIPTUNE_STUDIO_MCP_PORT`, `compose_track` intro / motif / variation, `compose_sfx`). Fix items on a ticket branch (`MDI-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, branch MDI-05_roadmap-features)

- Headless MCP on `127.0.0.1:7458/mcp` (`--mcp-only`, port from `--port` or `CHIPTUNE_STUDIO_MCP_PORT`), used by VN Studio for music.
- `compose_track` has `intro`, `motif` / `motifKey` and `variation`; `compose_sfx` makes sound effects, stingers and ambience loops.

## Open

- VN Studio (`C:\projects\Personal\visual-novels-orchestrator`) does not call `compose_sfx` yet. Its `sfx_` sounds need an imported file unless `sound.sfxEngine` is set (today only `custom:<comfy workflow>`), so a new value such as `sound.sfxEngine: "chiptune"` should call `compose_sfx` (with `path`) for `sfx_` sounds and for `amb_` ambience. That work is in the other repo.
