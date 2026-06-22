import type { Plugin } from '@opencode-ai/plugin';
import {
  DEFAULT_OBSERVER_MODEL,
  OBSERVER_SYSTEM_HINT,
  createObserverAgentConfig,
} from './agent';
import { processImageAttachments } from './image-hook';
import type { MessagesTransformOutput } from './types';

// ── Plugin state ──────────────────────────────────────────────────

let workDir: string | null = null;

function ensureWorkDir(): string {
  return workDir ?? process.cwd();
}

// ── Plugin entry ──────────────────────────────────────────────────

const plugin = (async (input) => {
  workDir = input.directory;

  return {
    // Register @observer as a subagent
    config: async (cfg: {
      agent?: Record<string, unknown>;
    }) => {
      const existing = (
        cfg.agent as Record<string, { model?: string }> | undefined
      )?.observer;
      const model = existing?.model ?? DEFAULT_OBSERVER_MODEL;
      const defaults = createObserverAgentConfig(model);

      cfg.agent = {
        ...cfg.agent,
        observer: {
          ...defaults,
          ...existing,
          model,
        },
      };
    },

    // Strip image parts and replace with @observer delegation hint
    'experimental.chat.messages.transform': async (
      _input: unknown,
      output: unknown,
    ) => {
      processImageAttachments(output as MessagesTransformOutput, {
        workDir: ensureWorkDir(),
      });
    },

    // Inject a brief @observer usage hint into the system prompt
    'experimental.chat.system.transform': async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!output.system.some((s) => s.includes(OBSERVER_SYSTEM_HINT))) {
        output.system.push(OBSERVER_SYSTEM_HINT);
      }
    },
  };
}) satisfies Plugin;

export default plugin;
