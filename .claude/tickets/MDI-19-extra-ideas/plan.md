---
status: in-progress
request: creative-hub/REQ-0030
repos: [midi-generator]
branch: MDI-19_extra-ideas
updated: 2026-11-22
---

# MDI-19 De-flake the Genesis perf test, and the Strata script path in the seed

Part of creative-hub HUB-40 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-40-extra-ideas\plan.md`, ideas 1 and 6 of REQ-0030).

The Genesis perf test fails on this PC: it expects 3 minutes of a 10-channel song to render in under 3000 ms and measured 3014-3172 ms during the HUB-38 runs. Decision (director): de-flake it with a margin and best-of-N, do not delete it; it still guards against a real slowdown (a 2x regression would take over 6 s).

## Scope

1. `tests/core/synth/genesis.test.ts:601-614`: best of 2 renders, limit 4000 ms.
2. `seed/config/providers.md:293`: the scripts are in `D:\Strata\terminal` (checked on disk 2026-11-22: `run-unsloth-ud-iq4_xs-parallel.bat`, `run-unsloth-ud-iq4_xs.bat`, `run-deepseek-v4.1-flash-ist-das-2.00bpw.bat`, `run-deepseek-v4.1-flash-ista-das-coder.bat`).
3. ROADMAP section.

## Out of scope

- The renderer, the other perf tests (`synth.test.ts:273` NES 2 s, `dreamcast.test.ts:919`, `synthPresets.test.ts:231`), `SKIP_PERF`.
- Anything else in the seed line 293 (for example its LM Studio sentence).

## Files and modules to touch (verified on master, 2026-11-22)

**`tests/core/synth/genesis.test.ts:601-614`** today:
```ts
describe('performance', () => {
  it.skipIf(process.env.SKIP_PERF === '1')('renders 3 minutes of a 10-channel Genesis song in under 3 s', () => {
    // 130 bpm, 16 rows per bar: one 64-row pattern = 4 bars ~ 7.4 s; 25 orders ~ 184 s
    const song = genesisSongFull(64, 25)
    song.loop = null // a looping song is rendered as intro + 2 bodies; time exactly 3 minutes of audio
    const t0 = performance.now()
    const r = renderSong(song, { sampleRate: SR, tailSec: 0 })
    const dt = performance.now() - t0
    const secs = r.L.length / SR
    console.log(`genesis perf: ${secs.toFixed(1)} s of audio in ${dt.toFixed(0)} ms`)
    expect(secs).toBeGreaterThanOrEqual(180)
    expect(dt).toBeLessThan(3000)
  })
})
```
After: title "renders 3 minutes of a 10-channel Genesis song in under 4 s (best of 2)"; render twice (same song), keep the shorter time; the `console.log` prints both times; `expect(secs).toBeGreaterThanOrEqual(180)` on the first render; `expect(best).toBeLessThan(4000)`; a one-line comment: "best of 2 and a 4 s limit: one render took 3.0-3.2 s here, so 3 s failed under a loaded machine (creative-hub HUB-40)". Two renders take about 6.5 s, under the 15 s `testTimeout` of `vitest.config.ts`; no per-test timeout needed. Keep `it.skipIf(process.env.SKIP_PERF === '1')`.

**`seed/config/providers.md:293`**: "chosen by the `run-*.bat` you start in `D:\Strata`:" becomes "chosen by the `run-*.bat` you start in `D:\Strata\terminal`:". Nothing else in the line changes.

## Tasks for workers

- **T1** the test change; **T2** the seed line; **T3** ROADMAP (`ROADMAP.md`, a new section after `## MDI-18: ACP for all` (line 64) and its text, same style):
  ```
  ## MDI-19: extra ideas of HUB-38 (2026-11-22, branch MDI-19_extra-ideas)

  creative-hub HUB-40, REQ-0030. The Genesis perf test takes the best of 2 renders and allows 4 s (one render took 3.0-3.2 s on this PC, so the 3 s limit failed); the seed names `D:\Strata\terminal` as the folder of the Strata scripts. Ticket: `.claude/tickets/MDI-19-extra-ideas/`.
  ```

## Acceptance criteria and the command that proves each

Commands (Bash): `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"; cd /c/projects/Personal/midi-generator`, then `yarn vitest run tests/core/synth/genesis.test.ts`, `yarn test`, `yarn typecheck`, `yarn lint`.

| # | criterion | proof |
|---|---|---|
| A1 | The perf test passes on this PC and still fails on a real slowdown | `yarn vitest run tests/core/synth/genesis.test.ts` passes 3 times in a row (note the printed times in the changelog); the limit is 4000 ms |
| A2 | The perf test still passes inside the full suite | `yarn test` |
| A3 | The seed's Strata path exists on disk | `grep -n "you start in" seed/config/providers.md`; `ls D:/Strata/terminal/run-*.bat` |
| A4 | Nothing else broke | `yarn typecheck`, `yarn lint` pass |

## UNTESTED

- The perf test on another machine or in CI.
