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
    concurrency: auto             # as many as the running Strata serves (its /status): 4 or 1, by the script you started
    discover: false               # Strata answers any model name, so fixed ids keep roles.md the same across quants
    json_schema: false            # Strata fails a bad structured answer (502) instead of constraining it
    models:
      - id: qwen3.8-flash-next
        family: qwen
        context: 131072
        tools: true
        extra_body: { reasoning_effort: none }
      - id: qwen3.8-flash-next-low
        family: qwen
        context: 131072
        tools: true
        extra_body: { reasoning_effort: low }
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

## Fields of a provider

- `id`: the name used in model references.
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

## Local models with tools

Tool calling works best with models that were trained for it (Qwen3 / Qwen3-Coder, Llama 3.x, Mistral, GPT-OSS, Gemma 3+). In LM Studio load the model with a context of at least 32768: the guide, the document summary and the tool list take about 8000 tokens before the conversation starts.

## Which models the chat offers

The chat's model dropdown shows only the models you tick in Settings > Models: the models listed here, the ones found by `discover` (OpenRouter's free ones, LM Studio models that are not listed here) and the ones you add by id. Settings > Models also lists everything a provider has (Detect models) and adds a model by its id. The choices are saved in `models.md` next to this file. A model that is not ticked can still be named in `roles.md`.
