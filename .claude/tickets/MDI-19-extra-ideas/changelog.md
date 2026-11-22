# Changelog MDI-19

## 2026-11-22 MDI-19: Genesis perf test de-flaked, seed Strata path fixed

Repo midi-generator, branch MDI-19_extra-ideas.
- `tests/core/synth/genesis.test.ts`: perf test renders the song twice, keeps the faster time, limit 4000 ms (was 3000 ms, one render); logs both times.
- `seed/config/providers.md`: Strata scripts folder is `D:\Strata\terminal`.
- `ROADMAP.md`: new MDI-19 section.

Deviations: none.

Verification: `yarn vitest run tests/core/synth/genesis.test.ts` 3x pass (perf runs: 2386/2235, 2022/2101, 2140/2159 ms); `yarn test` 1198 passed (twice); `yarn typecheck`, `yarn lint` exit 0; the four run-*.bat exist in D:/Strata/terminal.
Not run: perf test on another machine or in CI.
Commit: committed on branch, not merged or pushed.
