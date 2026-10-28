# Roadmap

What Chiptune Studio still lacks, found while VN Studio and the creative hub (`C:\projects\Personal\creative-hub`) drove it over MCP (2026-10-20, the pixel-art book *The Soother That Fell into Dragon Land*). Moved here from the hub's `ROADMAP.md` on 2026-10-22. Finished work is in `.claude/tickets/` (MDI-03 headless MCP, `compose_track` and `render_audio` for VN Studio; MDI-05 `CHIPTUNE_STUDIO_MCP_PORT`, `compose_track` intro / motif / variation, `compose_sfx`). Fix items on a ticket branch (`MDI-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, branch MDI-05_roadmap-features)

- Headless MCP on `127.0.0.1:7458/mcp` (`--mcp-only`, port from `--port` or `CHIPTUNE_STUDIO_MCP_PORT`), used by VN Studio for music.
- `compose_track` has `intro`, `motif` / `motifKey` and `variation`; `compose_sfx` makes sound effects, stingers and ambience loops.

## Open

Nothing. The last item (VN Studio calling `compose_sfx`) is done in VN Studio as VNO-19 (hub ticket HUB-13, branch `VNO-10-19_hub-roadmap` of `C:\projects\Personalvisual-novels-orchestrator`): `sound.sfxEngine: "chiptune"` makes `sfx_` sounds and `sound.ambienceEngine: "chiptune"` makes `amb_` ambience loops with `compose_sfx` (with `path`). It picks the sound name from the asset's key and description and falls back to `blip` / `drone` with a warning. The HUB-03 test game used a `compose_sfx` door sound imported by hand (2026-10-22).

## MDI-07: ACP proxy and custom providers (2026-10-27, branch MDI-07_acp-custom-providers)

Seed provider `acp` (ACP proxy, `http://127.0.0.1:7461/v1`, off until enabled), added once to existing configs by `config/seed-state.json`; Settings > Models has Add provider / Edit / Remove / Enable for OpenAI-compatible providers (`custom: true` in providers.md, key `CUSTOM_<ID>_API_KEY` in the credential store). Same shape as Pixel Studio PAR-14. Not yet checked live against the running proxy. Ticket: `.claude/tickets/MDI-07-acp-custom-providers/`.

## MDI-08: ACP live check through the real app (2026-10-27, branch MDI-08_acp-live-ui-check)

Playwright `_electron` spec `tests/e2e/acp-live.spec.ts` (gated by `ACP_LIVE=1`, proxy on `127.0.0.1:7461`, runs on a copy of `~/ChiptuneStudio/config`): Settings > Models shows `acp` with prefixed ids only, the Add provider form (Test, Detect, Remove) leaves the chat model selector valid, and the agent chat composes a melody on `acp/codex/gpt-5.6-luna` and `acp/antigravity/gemini-3.8-flash`. Fixes found on the way: seed migration inserts `acp` before `mock` with the seed's comments (CRLF-safe); removing a provider resets a chat model that was on it; providers.md writes are serialized; a newly added provider is selected in the list; JSON-action mode gets two repair retries and a line saying its actions are not host tool calls (the proxy's codex sometimes refused or broke the JSON). Ticket: `.claude/tickets/MDI-08-acp-live-ui-check/`.

## MDI-09: end-of-run result check for the agent (2026-10-28, branch MDI-09_agent-result-check)

A run could end "completed" with nothing made (MDI-08: a codex run made 8 tool calls and wrote no notes). `runAgent` takes `resultCheck { mutates, snapshot }`: when the model ends its turn after a mutating tool call and the app state (`get_song` without cursor / undo lines) equals the state before that call, it is sent back with "Your actions ran but the song is unchanged..." at most `MAX_RESULT_NUDGES = 2` times (`resultNudges`, `resultRetry()`; same names as Pixel Studio PAR-16). JSON-action mode checks the error guard first; native mode shares the check at its end of turn. Q&A runs are never nudged. Limit: the snapshot is the `get_song` summary (note counts per channel, orders, timing, instruments), so a write that only changes pitches in place looks unchanged. Ticket: `.claude/tickets/MDI-09-agent-result-check/`.
