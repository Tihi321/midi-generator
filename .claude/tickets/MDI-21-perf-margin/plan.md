---
status: in-progress
request: creative-hub/REQ-0031
repos: [midi-generator]
branch: MDI-21_perf-margin
updated: 2026-11-22
---

# MDI-21 The Genesis performance test states its real margin

Hub ticket: creative-hub HUB-44 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-44-pending-ideas\plan.md`, triage row P-41), request REQ-0031. Checked on master 9981150 (2026-11-22).

Commands (from `package.json`; Bash: `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"` first; `fnm exec yarn` fails): `yarn test` (`vitest run`), one file `npx vitest run tests/core/synth/genesis.test.ts`, `yarn typecheck`, `yarn lint`. No build. Never touch `C:\Users\Infplane\ChiptuneStudio`.

Rules: branch `MDI-21_perf-margin` cut from `master`, one commit; keep line endings (`*.md` LF in the tree, `.ts` CRLF); no test added or changed in behaviour (a comment only).

## Facts (verified)

- `tests/core/synth/genesis.test.ts:609-624`, `it('renders 3 minutes of a 10-channel Genesis song in under 4 s (best of 2)')`, skipped with `SKIP_PERF=1`; comment `:612`: "best of 2 and a 4 s limit: one render took 3.0-3.2 s here, so 3 s failed under a loaded machine (creative-hub HUB-40)"; assertion `:621` `expect(best).toBeLessThan(4000)`.
- HUB-40's checker (D40, REQ-0030 line 172): unloaded, one render takes about 1.4 s, so 4 s catches a slowdown of about 3x, not the 2x the MDI-19 plan claimed.

## Change

- `:612` becomes: `// best of 2 and a 4 s limit: unloaded, one render takes about 1.4 s (3.0-3.2 s on a loaded machine, creative-hub HUB-40), so this catches a slowdown of about 3x, not a small one`. If the worker's own run (below) measures a clearly different unloaded time, the comment uses the measured number and the changelog says so.
- Measure: run `npx vitest run tests/core/synth/genesis.test.ts` twice on an idle machine and record the render times (add a temporary `console.log(best)` locally, not committed, or read vitest's per-test duration) in the changelog.
- `ROADMAP.md`: a new section at the end in the style of `:72-74`: "## MDI-21: Genesis performance margin (2026-11-22, branch MDI-21_perf-margin)" and the body line "creative-hub HUB-44, REQ-0031. The Genesis performance test's comment says what its 4 s limit catches (about a 3x slowdown; one render takes about 1.4 s unloaded). Comment only. Ticket: `.claude/tickets/MDI-21-perf-margin/`."

## Tasks for workers

One worker: the comment, the measurement, ROADMAP; `yarn test`, `yarn typecheck`, `yarn lint`. Output: one commit `MDI-21: Genesis perf test states its real margin`; `.claude/tickets/MDI-21-perf-margin/changelog.md` with the measured times.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| M1 | the comment states the measured unloaded time and the slowdown the limit catches | `git diff` of `:612` |
| M2 | nothing else changes | `git diff --stat` (two files), `yarn test` |

## UNTESTED

- Nothing beyond the measurement on this machine.
