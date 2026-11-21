---
status: done
request: creative-hub/REQ-0030
repos: [midi-generator]
branch: MDI-18_acp-for-all
updated: 2026-11-21
---

# MDI-18 ACP for all: the composer and theory run on the local model through the ACP proxy (JSON-action mode); port 8787

Part of creative-hub HUB-38 (`C:\projects\Personal\creative-hub\.claude\tickets\HUB-38-acp-for-all\plan.md`). The user's decision: every app reaches every LLM, local ones included, through the ACP proxy (provider `acp`, `http://127.0.0.1:8787/v1`), which serves `gufo/*`, `strata/*`, `llama/*`. The `strata` and `lmstudio` providers stay in the code, switched off ("disable, keep code"). Chiptune has no vision need, so LM Studio is off too.

The proxy answers a request with `tools` to a local model with 400 `model_not_capable`, so local acp rows are `tools: false` and the composer agent uses its JSON-action mode (same `src/llm/agent.ts` lineage as Pixel Studio), as the existing acp cloud rows already do. The seed ships acp on the stale port 7461 (`seed/config/providers.md:119,223`). Code and seed only; the user's `~\ChiptuneStudio` is changed by the hub (HUB-38 L6).

## Contracts (copied from HUB-38; keep identical)

LOCAL = `acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs`. Defaults never name `gufo/*` or `llama/*`.

C1, the `acp` provider (seed), with `tools: false` on every row; cloud rows unchanged, local rows appended:

```yaml
  - id: acp
    name: ACP proxy
    kind: openai-compat
    enabled: true
    local: true
    base_url: http://127.0.0.1:8787/v1
    concurrency: 4
    json_schema: false
    discover: true
    discover_skip: [ qwen-image, nomic-embed ]
    models:
      # ... existing cloud rows (tools: false) unchanged ...
      # Local models through the proxy (HUB-38). One local model is loaded at a time across gufo, strata and llama;
      # a request for another one waits until the proxy has switched (minutes). LOCAL is the strata row.
      # The proxy refuses tools for local models: JSON-action mode.
      - id: strata/qwen3.8-flash-next-unsloth-ud-iq4_xs
        family: qwen
        context: 131072
        tools: false
        extra_body: { reasoning_effort: none }
      - id: gufo/Qwen3.8-27B
        family: qwen
        context: 32768
        tools: false
        extra_body: { reasoning_effort: none }
      - id: gufo/deepseek4
        family: deepseek
        context: 16384
        tools: false
        extra_body: { reasoning_effort: none }
      - id: gufo/flash-next-q4
        family: qwen
        context: 32768
        tools: false
        vision: true
        extra_body: { reasoning_effort: none }
      - id: llama/inkling-2-mini
        family: inkling
        context: 32768
        tools: false
        vision: true
      - id: llama/inkling-2-mini-dspark
        family: inkling
        context: 32768
        tools: false
        vision: true
```

C5: migration `acp-port-8787-v1` (recorded in `seed-state.json` `migrations`, like the Strata loaded migration) rewrites only the exact value `http://127.0.0.1:7461/v1` of the `acp` row's `base_url` in `config/providers.md` to `http://127.0.0.1:8787/v1`; a file it cannot parse is left alone with a warning and the migration is not recorded.

## Scope

1. Seed `seed/config/providers.md`: acp = C1 (`enabled: true`, 8787); `strata` row `enabled: false` (kept); `lmstudio` row `enabled: false` (kept). Prose line 223: acp on at 8787, the route to every model including local ones; JSON-action mode for local rows; no `PROXY_IGNORE_SAMPLING` needed (AAP-28); one local model on the GPU at a time, switches take minutes. Strata/LM Studio comments: off, kept as a way back.
2. Seed `seed/config/roles.md`: aliases `local: acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs`, `cloud`, `claude` unchanged; remove `strata`, `strata-low`; keep `lmstudio` alias only if removing it breaks a test or the alias check, else remove; `composer: [local]`, `theory: [local]`. Prose to match.
3. Migration `acp-port-8787-v1` (C5) in `src/llm/seedMigrate.ts`, next to the Strata loaded migration, called where that one is called.
4. Port strings: `src/renderer/components/ProviderForm.tsx:11,60`, `tests/e2e/acp-live.spec.ts:2,11,19` (gated by `ACP_LIVE=1`), `tests/llm/customProviders.test.ts:188,214,218,225,242,245` where the value stands for the proxy.
5. Read the seed merge in `src/llm/seedMigrate.ts`: confirm it does not re-enable `strata`/`lmstudio` in an existing folder.
6. Docs: `docs/llm-guide.md`, README/CLAUDE.md where they name LM Studio/Strata as the composer's model.
7. `ROADMAP.md` row (Chiptune uses `## MDI-NN: title (date, branch)` sections).

## Out of scope

Native tool calls for local models; removing provider code; vision; the user's data folder.

## Files

`seed/config/providers.md`, `seed/config/roles.md`, `src/llm/seedMigrate.ts`, `src/renderer/components/ProviderForm.tsx`, `tests/e2e/acp-live.spec.ts`, `tests/llm/customProviders.test.ts`, the seed-migration test in `tests/llm/`, docs, `ROADMAP.md`.

## Acceptance and tests

- A1 An existing folder with acp on 7461 gets 8787 once; a different value is kept. Test: one table case in the existing seed-migration test.
- A2 A fresh folder: acp on at 8787 with the six local rows all `tools: false`, `strata` and `lmstudio` off, `composer` and `theory` resolve to LOCAL. Check: existing seed assertions updated; no new test.
- A3 `yarn test`, `yarn typecheck`, `yarn build` pass (fnm default alias dir on PATH).
- Live (hub HUB-38 C7; GPU: Strata through the proxy; the user's go-ahead): one `composer` request on LOCAL produces a track change; no 400 in the proxy log.

## ROADMAP row

`## MDI-18: ACP for all (2026-11-21, branch MDI-18_acp-for-all)` with one paragraph: "creative-hub HUB-38, REQ-0030. The composer and theory run on LOCAL = `acp/strata/qwen3.8-flash-next-unsloth-ud-iq4_xs` through the ACP proxy in JSON-action mode; seed acp on at 8787 with the gufo/strata/llama rows (Inkling listed, not default), migration `acp-port-8787-v1`, `strata` and `lmstudio` off (code kept). Live check UNTESTED."
