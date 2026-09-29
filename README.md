# opencode-observer

Visual analysis plugin for [OpenCode](https://github.com/opencode-ai/opencode) — isolates image, screenshot, and PDF bytes from the main context by delegating to a vision-capable `@observer` subagent.

> **Origin**: Originally contributed to [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) in [PR #307](https://github.com/alvinunreal/oh-my-opencode-slim/pull/307), then extracted into this standalone plugin. This makes it available to any OpenCode user without requiring the full oh-my-opencode-slim framework — especially useful when your primary model is **not multimodal** (can't see images).

> **Compatibility**: Supports both **OpenCode V2** (`2.0.18+`, via `setup`) and **OpenCode V1** (`1.18.29+`, via `server`). The plugin auto-detects nothing — your host calls whichever entrypoint it knows.

## Install

```bash
npm install opencode-observer
```

### OpenCode V2

Add to your `opencode.json`/`opencode.jsonc` (note the `plugins` key, plural):

```jsonc
{
  "plugins": [
    "opencode-observer"
    // or with options:
    // { "package": "opencode-observer", "options": { "model": "google/gemini-2.5-flash", "temperature": 0.1 } }
  ]
}
```

### OpenCode V1 (legacy, ≥ 1.18.29)

```json
{
  "plugin": ["opencode-observer"],
  "agent": {
    "observer": {
      "model": "openai/gpt-4o"
    }
  }
}
```

> **Model**: Must be a vision-capable model. Default: `openai/gpt-4o`.
> Other good options: `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash`.

## How it works

```
User pastes screenshot
       │
       ▼
┌──────────────────────────────────────────────┐
│ V2: session.hook("context")                  │
│ V1: experimental.chat.messages.transform     │
│  • Detects image parts (media/image/file)    │
│  • Saves to .opencode/images/<sessionID>/    │
│  • Strips raw bytes from the request         │
│  • Injects @observer hint + system prompt    │
└──────────────────────────────────────────────┘
       │
       ▼
Orchestrator sees text hint:
  "Image detected. Delegate to @observer"
       │
       ▼
┌──────────────┐
│  @observer   │  ← vision-capable subagent
│  reads file  │
│  returns OCR │
└──────────────┘
       │
       ▼
Orchestrator receives structured text
```

### V1 → V2 API mapping

| V1 | V2 |
|----|-----|
| `config` hook (agent registration) | `ctx.agent.transform` → `editor.update("observer", …)` (upsert; preserves user-configured fields) |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` → edit `event.messages` |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` → edit `event.system` |
| agent `prompt` field | agent `system` field |
| agent `temperature` field | `options.temperature` plugin option (opt-in) or agent config `request.body.temperature` — unset by default because some models reject the parameter |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `options.model` (V2) / `agent.observer.model` (V1) | `openai/gpt-4o` | Vision model for image analysis |
| `options.temperature` (V2, opt-in) / `agent.observer.temperature` (V1) | unset (`0.1` in V1) | Low temperature for more deterministic OCR. V2 leaves it unset by default — reasoning models (`gpt-6-luna`, o-series) reject the parameter and fail the request; enable only if your vision model supports it. Alternatively set `request.body.temperature` on the agent in your config. |

A user-defined `observer` agent in your config always wins — the plugin only fills missing fields and enforces `mode: "subagent"`.

## Storage & cleanup

Images are saved to `.opencode/images/` inside your project (auto-ignored via `.opencode/.gitignore` so they won't be committed). The plugin periodically cleans up old images:

- **Max age**: files older than 1 hour are automatically deleted
- **Cleanup interval**: runs at most once every 10 minutes
- **Empty directories**: removed after all contained files expire

No manual cleanup needed — it won't accumulate.

## Uninstall

Remove from `opencode.json` (`plugins` in V2 / `plugin` in V1) and uninstall:

```bash
npm uninstall opencode-observer
```

## License

MIT
