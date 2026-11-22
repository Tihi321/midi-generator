---
status: in-progress
request: creative-hub/REQ-0030
repos: [midi-generator]
branch: MDI-20_lm-studio-prose
updated: 2026-11-22
---

# MDI-20 Seed: no more "keep only the nomic embedding model in LM Studio"

Hub ticket: creative-hub HUB-41 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-41-pixel-agent-and-small-ideas\plan.md`), request REQ-0030. The user said "new small ideas, build them now". Checked on master ffc8565 (2026-11-22).

## Scope

The Strata paragraph of `seed/config/providers.md` (line 293) ends with advice for LM Studio, which is not installed and which Chiptune Studio does not use (its `lmstudio` provider is off since MDI-18). Chiptune Studio has no embeddings at all: the only `embed` in `src/llm` is the discovery filter that leaves embedding models out (`src/llm/registry.ts:373,395,430`). Prose only.

## Out of scope

Everything else in the seed; any code; the live data folder `C:\Users\Infplane\ChiptuneStudio` (seed prose does not reach it; not planned).

## Files to touch (verified)

**`seed/config/providers.md:293`**, the last sentence of the Strata paragraph. Old:
"Strata takes most of the GPU memory with any of them: keep only the nomic embedding model in LM Studio and no ComfyUI while it runs."
New:
"Strata takes most of the GPU memory with any of them: no ComfyUI while it runs."

**`ROADMAP.md`**, a new section after the `## MDI-19` section (end of file, `:68-70`):
```
## MDI-20: seed prose (2026-11-22, branch MDI-20_lm-studio-prose)

creative-hub HUB-41, REQ-0030. The seed's Strata paragraph no longer says to keep the nomic embedding model in LM Studio (not installed, and Chiptune Studio has no embeddings). Prose only. Ticket: `.claude/tickets/MDI-20-lm-studio-prose/`.
```

## Tasks for workers

One task: the two edits above, verbatim (find the sentence by its text). Commands (Bash; Node under fnm): `export PATH="/c/Users/Infplane/AppData/Roaming/fnm/aliases/default:$PATH"`, then in `C:\projects\Personal\midi-generator`: `yarn test`, `yarn typecheck`, `yarn lint`, `yarn build`. No new test.

## Acceptance criteria

| # | criterion | proof |
|---|---|---|
| M1 | the sentence is gone | `grep -n "nomic embedding model in LM Studio" seed/config/providers.md` prints nothing |
| M2 | only the seed and ROADMAP changed | `git diff master --stat` |
| M3 | suite green | `yarn test`, `yarn typecheck`, `yarn lint`, `yarn build` exit 0 (the seed tests parse `providers.md`) |

## UNTESTED

Nothing runtime changes.
