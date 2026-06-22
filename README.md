# opencode-observer

Visual analysis plugin for [OpenCode](https://github.com/opencode-ai/opencode) — isolates image, screenshot, and PDF bytes from the main context by delegating to a vision-capable `@observer` subagent.

> **Origin**: Originally contributed to [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) in [PR #307](https://github.com/alvinunreal/oh-my-opencode-slim/pull/307), then extracted into this standalone plugin. This makes it available to any OpenCode user without requiring the full oh-my-opencode-slim framework — especially useful when your primary model is **not multimodal** (can't see images).

## Install

```bash
npm install opencode-observer
```

Then add to your `opencode.json`:

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
┌──────────────────────────────────┐
│  image-hook (messages.transform) │
│  • Detects image parts           │
│  • Saves to .opencode/images/    │
│  • Strips raw bytes              │
│  • Injects @observer hint        │
└──────────────────────────────────┘
       │
       ▼
Orchestrator sees text hint:
  "Image detected. Delegate to @observer"
       │
       ▼
┌──────────────┐
│  @observer   │  ← vision-capable model
│  reads file  │
│  returns OCR │
└──────────────┘
       │
       ▼
Orchestrator receives structured text
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `agent.observer.model` | `openai/gpt-4o` | Vision model for image analysis |
| `agent.observer.temperature` | `0.1` | Low temperature for accurate OCR |

## Storage & cleanup

Images are saved to `.opencode/images/` inside your project (auto-ignored via `.opencode/.gitignore` so they won't be committed). The plugin periodically cleans up old images:

- **Max age**: files older than 1 hour are automatically deleted
- **Cleanup interval**: runs at most once every 10 minutes
- **Empty directories**: removed after all contained files expire

No manual cleanup needed — it won't accumulate.

## Uninstall

Remove from `opencode.json` plugins and uninstall:

```bash
npm uninstall opencode-observer
```

## License

MIT
