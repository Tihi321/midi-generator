# MDI-09: end-of-run result check for the agent

Branch `MDI-09_agent-result-check`. Problem: a run can end "completed" with nothing made (MDI-08: one codex run made 8 tool calls and wrote no notes).

## Change
- `src/llm/agent.ts`: `RunAgentOptions.resultCheck?: ResultCheck { mutates(tool), snapshot() }`, `MAX_RESULT_NUDGES = 2`, counter `resultNudges`, helper `resultRetry()` (same names as Pixel Studio PAR-16). The state is read from the app: `snapshot()` just before the first mutating tool call and again when the model ends the turn; equal means unchanged, so the model gets "Your actions ran but the song is unchanged..." and the loop goes on, at most twice. Never fires on runs without a mutating tool (Q&A: no snapshot is even read) or when the state changed. In JSON mode the error guard (`errorNudges` / `lastError`) runs first; the result guard covers empty-actions and `done: true` ends. Native mode: same check at its end-of-turn (a reply without tool calls).
- `src/main/agent.ts`: `songResultCheck(bridge)`: mutating = registry tools that are not `readOnly` / `noTransaction` (so not undo, redo) and not `delete_song`; snapshot = `get_song` text without the Cursor / Undo lines (timing, orders, notes per channel, instruments).
- Tests: tests/llm/agent.test.ts (fires, not on Q&A, not when changed, cap, error guard first, native, unreadable state), tests/main/agent.test.ts (runner wiring).

## Verify
vitest, typecheck, lint, build, live spec `ACP_LIVE=1 ACP_REPEAT=3` on a config copy (real config diffed before/after).
