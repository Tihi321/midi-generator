---
kind: providers
# LM Studio loading: when a request goes to an LM Studio model that isn't loaded, Chiptune Studio loads it with these settings.
# A model entry can override the context and parallel count with load_context and load_parallel.
# The context size in Settings (Providers) overrides both contexts for every LM Studio model.
lmstudio_parallel: 1
lmstudio_context: 131072
lmstudio_ttl_minutes: 60
providers:
  - id: lmstudio
    kind: openai-compat
    local: true
    base_url: http://localhost:1234/v1
    concurrency: auto             # the sum of `parallel` over the loaded chat models, 1 when none is loaded
    discover: true                # the list is the installed models (listed ones it lacks are left out); LM Studio reports tool and vision support
    load_models: true             # load a model that isn't loaded yet (lms load, or LM Studio's API when lms isn't installed)
    models:
      - id: nail-qwen3.6-35b-a3b-mtp
        family: qwen
        tools: true
        extra_body: { reasoning_effort: low }
        load_parallel: 1
      - id: ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp
        family: qwen
        tools: true
        vision: true
        extra_body: { reasoning_effort: low }
        load_parallel: 1
      - id: google/gemma-4-e4b
        family: gemma
        tools: false              # small model: the agent uses JSON-action mode
        vision: true
        extra_body: { reasoning_effort: none }
      - id: nvidia/nemotron-3-nano-4b
        family: nemotron
        tools: false
        extra_body: { reasoning_effort: none }
  - id: strata
    kind: openai-compat
    local: true
    base_url: http://127.0.0.1:8080/v1
    api_key_env: STRATA_API_KEY   # optional: only sent if set
    concurrency: auto             # as many as the running Strata serves (its /v1/status)
    discover: true                # ask Strata which model it runs (GET /v1/models, and `model` of /v1/status)
    json_schema: false            # Strata fails a bad structured answer (502) instead of constraining it
    models:                       # the refs roles use; each stands for whatever model Strata has loaded
      - id: default               # thinking off
        loaded: true
        aliases: [qwen3.8-flash-next]
        context: 131072           # used until Strata has answered once
        tools: true
        extra_body: { reasoning_effort: none }
      - id: default-low           # thinking on low, for the checks
        loaded: true
        aliases: [qwen3.8-flash-next-low]
        context: 131072
        tools: true
        extra_body: { reasoning_effort: low }
    profiles:                     # settings per model Strata may run, matched by id prefix; not refs, not in pickers
      - id: qwen3.8-flash-next    # matches qwen3.8-flash-next-unsloth-ud-iq4_xs and any other Qwen3.8-Flash-Next quant
        family: qwen
        context: 131072
      - id: deepseek-v4.1-flash
        family: deepseek
        context: 131072
  - id: deepseek
    kind: openai-compat
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    concurrency: 8
    json_schema: false            # DeepSeek answers response_format json_schema with HTTP 400 (checked 2026-10-12)
    models:
      - id: deepseek-flash          # DeepSeek-V4.1-Flash
        family: deepseek
        context: 1000000
        price_in: 0.30
        price_out: 1.20
        price_cached_in: 0.006
        tools: true
        extra_body: { thinking: { type: disabled } }
      - id: deepseek-v4-pro         # DeepSeek-V4-Pro, thinks by default
        family: deepseek
        context: 1000000
        price_in: 1.32
        price_out: 3.96
        price_cached_in: 0.044
        tools: true
        extra_body: null
  - id: openrouter
    kind: openai-compat
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    concurrency: 4
    rpm: 20                       # OpenRouter's limit for the free models
    discover: free                # adds every model OpenRouter lists at price 0 (the `:free` ones); tick them in Settings > Models
    discover_skip: [content-safety]
    json_schema: false            # not every model there supports response_format
    models:
      # to verify
      - id: google/gemini-2.5-flash
        family: gemini
        context: 1000000
        price_in: 0.30
        price_out: 2.50
        tools: true
        vision: true
      - id: anthropic/claude-sonnet-4.5
        family: claude
        context: 200000
        price_in: 3
        price_out: 15
        tools: true
        vision: true
  - id: acp
    name: ACP proxy
    kind: openai-compat
    enabled: false                # switch on in Settings > Models (or here) when the proxy runs
    local: true
    base_url: http://127.0.0.1:7461/v1
    concurrency: 2
    discover: true                # ids look like codex/gpt-5.6-luna, antigravity/gemini-3.8-flash
    json_schema: false            # the proxy does not constrain a structured answer
    models: []
  - id: ollama
    kind: openai-compat
    enabled: false                # switch on if you run Ollama
    local: true
    base_url: http://localhost:11434/v1
    concurrency: 1
    discover: true                # discovered models get tools: false (JSON-action mode) unless you list them below
    models: []
  - id: openai
    kind: openai-compat
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: gpt-4.1
        family: gpt
        context: 1000000
        price_in: 2
        price_out: 8
        price_cached_in: 0.5
        tools: true
        vision: true
      - id: gpt-4.1-mini
        family: gpt
        context: 1000000
        price_in: 0.4
        price_out: 1.6
        price_cached_in: 0.1
        tools: true
        vision: true
  - id: anthropic
    kind: anthropic
    base_url: https://api.anthropic.com
    api_key_env: ANTHROPIC_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: claude-opus-5-5
        family: claude
        context: 200000
        max_output: 16000
        tools: true
        vision: true
      - id: claude-sonnet-5-5
        family: claude
        context: 200000
        max_output: 16000
        tools: true
        vision: true
      - id: claude-haiku-5-5
        family: claude
        context: 200000
        max_output: 16000
        tools: true
        vision: true
  - id: gemini
    kind: gemini
    base_url: https://generativelanguage.googleapis.com
    api_key_env: GEMINI_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: gemini-2.5-flash
        family: gemini
        context: 1000000
        price_in: 0.30
        price_out: 2.50
        price_cached_in: 0.03
        tools: true
        vision: true
      - id: gemini-2.5-pro
        family: gemini
        context: 1000000
        price_in: 1.25
        price_out: 10
        price_cached_in: 0.31
        tools: true
        vision: true
  - id: mock
    kind: mock
    enabled: false                # tests switch it on
    concurrency: 4
    models:
      - id: mock-tools
        family: mock
        tools: true
      - id: mock-json
        family: mock
        tools: false
---
# Providers

One entry per provider. Edit this file in `~/ChiptuneStudio/config/` and Chiptune Studio picks the change up after a reload. API keys are never written here: `api_key_env` names an environment variable, and Chiptune Studio also looks in the Windows credential store under that name (Settings stores them there).

A model is written `provider/model`, for example `lmstudio/google/gemma-4-e4b`. Prices are USD per 1M tokens and only used for the cost shown in the chat (there is no budget). The OpenRouter, OpenAI, Anthropic and Gemini entries are examples marked "to verify": model ids and prices there may be out of date. The Anthropic 5.5 models have no prices here (the cost shows as 0 until you add `price_in`, `price_out` and `price_cached_in`). The DeepSeek ones come from scriptorium's config (peak prices); DeepSeek rejects `response_format: json_schema`, so it has `json_schema: false`, and `deepseek-v4-pro` thinks before it answers (its reasoning is sent back with tool calls, which DeepSeek requires).

## ACP proxy

`acp` is the ACP proxy (an OpenAI-compatible API over your Codex / Antigravity / Claude subscriptions, `http://127.0.0.1:7461/v1`). It is off by default: turn it on in Settings > Models, then Detect models and tick the ones you want (ids look like `codex/gpt-5.6-luna`). Start the proxy with `PROXY_IGNORE_SAMPLING=1`, because the agent sends `temperature`, `max_tokens` and `stream_options`. It is text only (no vision). Models of a local provider default to `tools: false` (JSON-action mode); list a model here with `tools: true` to use native tool calling. `PROXY_TIMEOUT_MS` (default 5 minutes) must cover long requests. Using a subscription through a proxy may be against its terms (Antigravity especially): your call.

## Your own providers

Settings > Models > Add provider adds any OpenAI-compatible server (name, base URL, API key, parallel requests, JSON schema, discover, model ids) as an entry with `custom: true` and a `name`. The app edits and removes only those entries; the keys go to the credential store as `CUSTOM_<ID>_API_KEY`. The ids of the seed providers (`acp`, `openai`, `deepseek`, ...) cannot be used. `config/seed-state.json` records which seed providers were already offered, so a new seed provider (like `acp`) is added to an existing providers.md once and a deleted one does not come back.

## Fields of a provider

- `id`: the name used in model references. `name`: optional label shown in the UI. `custom`: `true` for providers added in the UI.
- `kind`: `openai-compat` (any OpenAI-style API: LM Studio, Strata, DeepSeek, OpenRouter, Ollama, OpenAI), `anthropic`, `gemini`, or `mock` (scripted, for tests).
- `enabled`: `false` switches the provider off. A provider whose key can't be found is skipped automatically.
- `local`: `true` for models on this machine. Local models cost nothing. Models of a local provider default to `tools: false`.
- `base_url`, `api_key_env`: where to call and which variable holds the key.
- `concurrency`: how many requests may run at once. `auto`: as many as the server says it serves (Strata `/status`, LM Studio loaded slots), 1 while the server is down.
- `rpm`: optional requests per minute.
- `discover`: ask the provider for its models (`GET /v1/models`, and LM Studio's own list of downloaded models). When it answers, the provider's list is exactly its installed models: the ones listed here keep their settings, unknown ones are added, listed ones it doesn't have, embedding models and speculative-decoding draft models (LM Studio `arch: dflash`) are left out. The chat's model list asks again each time it opens.
- `discover: free` (OpenRouter): only the models the provider lists at price 0 are added (context, tools and vision come from its list), and the models listed here are kept. Tick the ones you want in Settings > Models. `discover_skip`: a list of words; a discovered model whose id contains one of them (any case) is left out.
- `json_schema`: `true` (the default) sends the JSON schema of a structured answer as `response_format`. Set `false` for a server that answers a bad JSON reply with an error.
- `load_models` (LM Studio): load a model that isn't loaded yet with `lmstudio_parallel`, `lmstudio_context` and `lmstudio_ttl_minutes`. The context size in Settings replaces `lmstudio_context` and every `load_context`, and a model loaded with a smaller context is loaded again on its next request.

## Fields of a model

- `id`, `family`, `context`, `max_output`.
- `price_in`, `price_out`, `price_cached_in`: USD per 1M tokens (display only).
- `tools`: the model supports native tool calling. Remote models default to `true`, local ones to `false`. A model with `tools: false` still works: the agent describes the tools in the prompt and the model answers with JSON actions (slower and less reliable). LM Studio reports `tool_use` for the models it discovers, and that is used when the model is not listed here.
- `vision`: the model can look at images. The agent then gets the `render_preview` images of its own work, and the style reference images. Default `false`: images are replaced by a text note.
- `extra_body`: JSON fields merged into the request body. The LM Studio models send `reasoning_effort` to limit thinking. DeepSeek `deepseek-flash` sends `thinking: { type: disabled }` (with thinking on it spends the answer budget on reasoning). Empty means nothing extra.
- `load_context`, `load_parallel` (LM Studio): this model's own load settings.
- `json_schema`: this model's own setting, over the provider's.
- `loaded: true` (Strata): the row stands for whichever model the server has loaded, see Strata below. `aliases`: other names the row answers to (old refs such as `strata/qwen3.8-flash-next`); they are not listed as models.

## Strata

Strata serves one model per process on port 8080, chosen by the `run-*.bat` you start in `D:\Strata`: `run-unsloth-ud-iq4_xs-parallel.bat`, `run-unsloth-ud-iq4_xs.bat` (Qwen3.8-Flash-Next) and `run-deepseek-v4.1-flash-ist-das-2.00bpw.bat`, `run-deepseek-v4.1-flash-ista-das-coder.bat` (DeepSeek-V4.1-Flash). Chiptune Studio asks it which one it runs (`model` of `/v1/status`, `/v1/models`) and takes the settings from `profiles`: the entry whose `id` is the model's id, else the longest one the id starts with (`family`, `context`, `extra_body`, `tools`, `vision`, `json_schema`, `max_output`). The two `loaded` rows, `strata/default` (thinking off) and `strata/default-low` (thinking low), follow it, so `roles.md` never names a model; the chat shows `Strata: <model>`. A row's own `extra_body` wins over the profile's, and `context` in a profile must match the `--max-context` of the config (131072 for all four now). When you install a new model, add a profile for it. Strata takes most of the GPU memory with any of them: keep only the nomic embedding model in LM Studio and no ComfyUI while it runs.

## Local models with tools

Tool calling works best with models that were trained for it (Qwen3 / Qwen3-Coder, Llama 3.x, Mistral, GPT-OSS, Gemma 3+). In LM Studio load the model with a context of at least 32768: the guide, the document summary and the tool list take about 8000 tokens before the conversation starts.

## Which models the chat offers

The chat's model dropdown shows only the models you tick in Settings > Models: the models listed here, the ones found by `discover` (OpenRouter's free ones, LM Studio models that are not listed here) and the ones you add by id. Settings > Models also lists everything a provider has (Detect models) and adds a model by its id. The choices are saved in `models.md` next to this file. A model that is not ticked can still be named in `roles.md`.
