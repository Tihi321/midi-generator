# Roadmap

What Chiptune Studio still lacks, found while VN Studio and the creative hub (`C:\projects\Personal\creative-hub`) drove it over MCP (2026-10-20, the pixel-art book *The Soother That Fell into Dragon Land*). Moved here from the hub's `ROADMAP.md` on 2026-10-22. Finished work is in `.claude/tickets/` (MDI-03 headless MCP, `compose_track` and `render_audio` for VN Studio). Fix items on a ticket branch (`MDI-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master 0b2252b)

- Headless MCP on `127.0.0.1:7458/mcp` (`--mcp-only`), used by VN Studio for music. Hand-writing a track with `write_melody` + `wrap` per channel works well: four 16-bar NES tracks in the soother run.

## Sound for visual novels

- No SFX, stingers or ambience. VN Studio (VNO-08) now has `sfx_` and `amb_` sounds: ambience uses the music engine, and an SFX needs an imported file unless `sound.sfxEngine` is set, so an SFX tool here would plug in there.
