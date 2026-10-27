# Changelog MDI-08

## 2026-10-27 - ACP proxy passes through the real app
Branch `MDI-08_acp-live-ui-check` (master). Uncommitted until the commit that carries this file.

- `src/llm/seedMigrate.ts`: text insertion of the seed entry before `mock`, seed comments kept, CRLF-safe, validated before writing.
- `src/llm/fileLock.ts` (new), `customProviders.ts`, `seedMigrate.ts`: per-file in-process mutex around every providers.md read-modify-write.
- `src/main/llm.ts`: `removeProvider` clears `selectedModel` when it was on the removed provider.
- `src/renderer/components/ProviderForm.tsx`: a newly added provider is selected in the Models list.
- `src/llm/json.ts`, `src/llm/agent.ts`: two repair retries; JSON-action instructions say the actions are run by the app, not the host (codex via ACP once answered "this request disallows tool calls", once returned broken JSON twice).
- `tests/e2e/acp-live.spec.ts`, `tests/e2e/launch.ts` (`configFrom` option): the live spec.
- Tests: tests/llm/customProviders.test.ts (migration order/CRLF, lock, selection reset), tests/llm/agent.test.ts (repairs).
- Verification: see final report; the live spec passed 4/4 (a, b, c on both models). The real `~/ChiptuneStudio/config` is never written (the app runs on a copy); backup `config.bak-mdi08` diffs identical.
- Not verified: agent runs are nondeterministic (one codex run made 8 tool calls and wrote no notes before the fixes); playing the result by ear; the old Pixel-style `seed-state` legacy ids path.
