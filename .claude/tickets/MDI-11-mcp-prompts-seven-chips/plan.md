# MDI-11: MCP prompts list all seven chips

Branch: `MDI-11_mcp-prompts-seven-chips`. Part of hub ticket HUB-18 (section 2).

- [x] `src/main/mcpContent.ts`: `compose_track` chip argument lists nes, gb, genesis, snes, pce, ps1, dreamcast; mood example adds "synthwave"; the default is the mood's chip (matches the `compose_track` tool). With no chip the prompt omits `chip` in `new_song` / `get_mood_recipe` instead of forcing `nes`.
- [x] `remix_to_chip` chip argument lists all seven chips.
- [x] Grepped `src/` for other five-chip lists: none left (tools and guide already list seven).
- [x] Test in `tests/mcp/assets.test.ts`.
- [x] `ROADMAP.md` MDI-11 paragraph. Docs unchanged, so no `yarn gen:guide`.
