# MDI-12 changelog

## 2026-11-04 MDI-12 (HUB-26 T6): Chiptune Studio follows whichever model Strata runs

Branch `MDI-12_strata-model-discovery`. Replay of PAR-17; committed on the branch, not merged or pushed.

### What changed
- `src/llm/config.ts`: model `loaded`, `aliases`, `json_schema`; provider `profiles`.
- `src/llm/registry.ts`: `applyServed`, `setServed`, `findProfile`, `legacyRefs` in `resolve`, `discover` and `dropMissing` handling of loaded rows, empty catalog for such a provider, `syncServerSlots` returns `{ slots, served }`.
- `src/llm/openaiCompat.ts`, `types.ts`, `router.ts`: `alias_of` / `n_ctx` from `/v1/models`, per-model `json_schema`.
- `src/llm/seedMigrate.ts`: `migrateStrataLoaded` (`strata-loaded-v1`, recorded in `seed-state.json` `migrations`; `readState` now keeps that key); called from `src/llm/setup.ts`.
- `src/main/llm.ts`, `src/shared/agent.ts`, `ChatPanel.tsx`, `ModelsTab.tsx`: label `Strata: <model>[, thinking low]`, `served`, `console.info` on a switch.
- `seed/config/providers.md`, `roles.md`: loaded rows, profiles, neutral `strata` / `strata-low` aliases, docs.

### Deviations from PAR-17
- Migration lives in `seedMigrate.ts` and uses this repo's helpers (`parseProviders` returning undefined, `withFileLock`, atomic tmp+rename write, `SeedState.migrations`); same behaviour and result shape.
- Same Pixel deviations from C1 kept: no provider-down state, `console.info` instead of an engine event, label capitalises the provider id.
- Seed test expectation in `tests/llm/registry.test.ts:76` changed to `strata/default-low` (old ref resolves to the loaded row).

### Verification
- `yarn typecheck`: clean. `yarn test` (vitest run): 79 files, 1186 tests passed.
- Not run: the Electron app, a real Strata, a live model switch, `yarn test:electron`.
