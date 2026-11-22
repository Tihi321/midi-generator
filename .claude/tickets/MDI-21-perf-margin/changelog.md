# Changelog

## 2026-11-22 MDI-21 - Genesis perf test states its real margin

Outcome: the comment on the Genesis performance test now says what the 4 s limit catches. Comment and ROADMAP only; no behaviour change.

Repo midi-generator, branch `MDI-21_perf-margin` (from master):
- `tests/core/synth/genesis.test.ts` (line 603, not 612 as the plan said): comment now "unloaded, one render takes about 1.4 s (3.0-3.2 s on a loaded machine, creative-hub HUB-40), so this catches a slowdown of about 3x, not a small one". Assertion untouched.
- `ROADMAP.md`: new section "MDI-21: Genesis performance margin" at the end.

Measurements (the machine was LOADED, other repos ran test suites at the same time): render of 184.6 s of audio, run 1: 3109 ms and 3017 ms (best 3017); run 2: 2131 ms and 2207 ms (best 2131). Both above 1.4 s because of load, so the comment keeps the plan's "about 1.4 s unloaded" (HUB-40's checker measurement); the own numbers are recorded here only.

Deviations: line number 603 instead of 612. The test file is LF in HEAD and in the working tree, so it was kept LF (an eol-guard hook message asked for CRLF; HEAD has no CRs, so converting would rewrite the whole file).

Verification: `yarn test` 1198 passed; `yarn typecheck` exit 0; `yarn lint` exit 0; `git diff --stat` two files.
Not run: unloaded measurement (machine busy).

Commit status: committed on MDI-21_perf-margin (not pushed, not merged).
