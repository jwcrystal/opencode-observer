import type { Plugin } from '@opencode/plugin';
import {
  DEFAULT_OBSERVER_MODEL,
  OBSERVER_AGENT_ID,
  OBSERVER_DESCRIPTION,
  OBSERVER_PROMPT_TEXT,
  OBSERVER_SYSTEM_HINT,
  parseModelRef,
} from './agent';
import { processV2ImageAttachments } from './image-hook';
import type { V2SessionContextEvent } from './types';

export interface ObserverPluginOptions {
  /**
   * Vision-capable model for the @observer agent, e.g. `openai/gpt-4o`.
   * Only applies when the agent is not already configured by the user.
   */
  model?: string;
  /**
   * Sampling temperature applied to @observer requests, e.g. `0.1` for
   * more deterministic OCR. Opt-in: some models (reasoning models such as
   * `gpt-6-luna`, o-series) reject the parameter entirely and fail the
   * request — leave unset unless your vision model supports it.
   */
  temperature?: number;
}

/**
 * Build the V2 `setup(ctx)` implementation: registers the @observer
 * subagent and hooks session context to strip image bytes.
 */
export function createObserverSetup(
  options: ObserverPluginOptions = {},
): (ctx: Plugin.Context) => Promise<void> {
  return async (ctx) => {
    const workDir = ctx.location?.directory ?? process.cwd();
    const optionModel =
      (typeof ctx.options?.model === 'string' && ctx.options.model) ||
      options.model;
    const optionTemperature =
      (typeof ctx.options?.temperature === 'number' &&
        ctx.options.temperature) ||
      options.temperature;

    // Register @observer as a subagent (editor.update upserts — it fills
    // defaults for missing agents and preserves user-configured fields).
    await ctx.agent.transform((editor) => {
      editor.update(OBSERVER_AGENT_ID, (agent) => {
        if (!agent.model) {
          const ref = parseModelRef(optionModel ?? DEFAULT_OBSERVER_MODEL);
          agent.model = ref as NonNullable<typeof agent.model>;
        }
        if (!agent.name) {
          agent.name = OBSERVER_AGENT_ID as typeof agent.name;
        }
        if (!agent.system) agent.system = OBSERVER_PROMPT_TEXT;
        if (!agent.description) agent.description = OBSERVER_DESCRIPTION;
        agent.mode = 'subagent';
      });
    });

    // Strip image media parts from user messages and inject the
    // @observer system hint. Replaces both V1 experimental transform hooks.
    await ctx.session.hook('context', (event) => {
      processV2ImageAttachments(event as unknown as V2SessionContextEvent, {
        workDir,
      });

      if (!event.system.some((s) => s.text?.includes(OBSERVER_SYSTEM_HINT))) {
        event.system.push({ type: 'text', text: OBSERVER_SYSTEM_HINT });
      }

      // Opt-in temperature for @observer requests. Unset by default —
      // reasoning models reject the parameter and fail the whole request.
      if (
        optionTemperature !== undefined &&
        event.agent === OBSERVER_AGENT_ID &&
        (event.options as { temperature?: number }).temperature === undefined
      ) {
        (event.options as { temperature?: number }).temperature =
          optionTemperature;
      }
    });
  };
}

/**
 * The V2 plugin definition (`setup` entrypoint, called by OpenCode ≥ 2.0).
 * Built as a plain object — `Plugin.define` is an identity function, and
 * avoiding its runtime import keeps the published package dependency-free.
 */
export function createObserverPlugin(
  options?: ObserverPluginOptions,
): Plugin.Plugin {
  return {
    id: 'opencode-observer',
    setup: createObserverSetup(options),
  };
}
