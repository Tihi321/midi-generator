# Changelog MDI-18

## 2026-11-21 MDI-18 ACP for all (creative-hub HUB-38, REQ-0030)

Outcome: the seed makes the ACP proxy (port 8787) the route to every model; composer and theory run on LOCAL = `acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs` in JSON-action mode. Live check not run.

Repo midi-generator, branch `MDI-18_acp-for-all` (from `origin/master`).

- `seed/config/providers.md`: acp `enabled: true`, `http://127.0.0.1:8787/v1`, concurrency 4, `discover_skip`, six local rows (strata, gufo x3, llama x2), all `tools: false` (C1; the seed's acp had `models: []`, so there were no cloud rows to keep); `lmstudio` and `strata` `enabled: false` (code kept); ACP prose rewritten (on, 8787, JSON-action mode, no PROXY_IGNORE_SAMPLING, one GPU model at a time).
- `seed/config/roles.md`: aliases `local` (LOCAL), `cloud`, `claude`; `strata`, `strata-low` and `lmstudio` removed (nothing in tests or the alias check needed `lmstudio`); `composer` and `theory` are `[local]`; prose matched.
- `src/llm/seedMigrate.ts`: `migrateAcpPort` (`acp-port-8787-v1`, C5): rewrites only the exact `http://127.0.0.1:7461/v1` of the acp `base_url`, recorded in `seed-state.json` `migrations`; an unreadable or invalid file is left alone with a warning and not recorded. `src/llm/setup.ts` calls it after the Strata loaded migration.
- `src/renderer/components/ProviderForm.tsx`, `tests/e2e/acp-live.spec.ts`: port 8787.
- Tests (extended, none new files): `tests/llm/customProviders.test.ts` (seed acp assertions; one new table-style case for the migration, A1; port strings), `tests/llm/registry.test.ts` and `tests/main/agentLlm.test.ts` (A2: acp on, six rows `tools: false`, lmstudio and strata off, composer and theory resolve to LOCAL).

Read and confirm (scope 5): `migrateSeedProviders` only adds seed providers listed in `MIGRATED_SEED_PROVIDERS` (`['acp']`) that the folder lacks and never edits an existing entry; `migrateStrataLoaded` touches only the strata `models`, `discover`, `profiles` and the old refs. Neither writes `enabled`, so neither re-enables `strata` or `lmstudio` in an existing folder. Consequence: an existing folder keeps its own `enabled`, roles and rows; only the port moves. Turning on acp, adding the local rows and the `local` roles there is the hub's HUB-38 L6.

Docs (scope 6): README.md and docs/llm-guide.md do not name LM Studio, Strata or the proxy; there is no CLAUDE.md. No change. ROADMAP.md: MDI-18 section added.

Deviations: none of substance. One behaviour change in a test: with composer on a JSON-action model, `candidates('composer', { agentModel: 'claude', requireTools: true })` is now 1 (was 2), because the local fallback has no native tools (the router rule).

Verification (Node from the fnm default alias dir on PATH):
- `yarn test`: 1197 passed, 1 failed: `tests/core/synth/genesis.test.ts` perf test (3172 ms and 3014 ms against a 3000 ms limit, also alone), a timing check in code this ticket does not touch.
- `yarn typecheck`: exit 0. `yarn build`: built.
Not run: the live ACP e2e (`ACP_LIVE=1`), the live composer request on LOCAL (A-live), anything against the proxy.

Commit status: uncommitted, nothing pushed.
