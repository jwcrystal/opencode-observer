import {
  DEFAULT_OBSERVER_MODEL,
  OBSERVER_SYSTEM_HINT,
  createObserverAgentConfig,
} from './agent';
import { processImageAttachments } from './image-hook';
import type { MessagesTransformOutput } from './types';
import { createObserverPlugin } from './v2';
import type { ObserverPluginOptions } from './v2';

// ── Plugin state (V1 path) ────────────────────────────────────────

let workDir: string | null = null;

function ensureWorkDir(): string {
  return workDir ?? process.cwd();
}

// ── V1 hooks ──────────────────────────────────────────────────────

function createV1Hooks() {
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
}

// ── Dual entry (V2 setup + V1 server) ─────────────────────────────
//
// OpenCode 2.x reads `setup` and ignores `server`; OpenCode 1.x
// (>= 1.18.29, object entrypoints) reads `server` and ignores `setup`.
// See https://opencode.ai/v2/docs/build/plugins/migrate-v1

const observerV2 = createObserverPlugin();

export type { ObserverPluginOptions };

const entry = {
  ...observerV2,

  /** V1 entrypoint — returns the V1 hook map. */
  server: async (input?: { directory?: string }) => {
    if (input?.directory) workDir = input.directory;
    return createV1Hooks();
  },
};

export default entry;
