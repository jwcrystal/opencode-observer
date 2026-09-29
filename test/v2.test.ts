import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OBSERVER_MODEL,
  OBSERVER_AGENT_ID,
  OBSERVER_PROMPT_TEXT,
  OBSERVER_SYSTEM_HINT,
  parseModelRef,
} from '../src/agent';
import { processV2ImageAttachments } from '../src/image-hook';
import type { V2ContentPart, V2SessionContextEvent } from '../src/types';
import { createObserverSetup } from '../src/v2';

const TEST_DIR = join(import.meta.dir, '..');

// ── parseModelRef ─────────────────────────────────────────────────

describe('parseModelRef', () => {
  test('parses provider/model', () => {
    expect(parseModelRef('openai/gpt-4o')).toEqual({
      providerID: 'openai',
      id: 'gpt-4o',
    });
  });

  test('parses provider/model#variant', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-6#thinking')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-4-6',
      variant: 'thinking',
    });
  });

  test('defaults provider to openai when missing', () => {
    expect(parseModelRef('gpt-4o')).toEqual({
      providerID: 'openai',
      id: 'gpt-4o',
    });
  });
});

// ── processV2ImageAttachments ─────────────────────────────────────

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeV2Event(
  overrides: Partial<V2SessionContextEvent> = {},
): V2SessionContextEvent {
  return {
    sessionID: 'ses_v2-test',
    agent: 'build',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [],
    options: {},
    ...overrides,
  };
}

describe('processV2ImageAttachments', () => {
  test('strips media parts from user messages and injects hint', () => {
    const event = makeV2Event({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'media', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          ],
        },
      ],
    });

    processV2ImageAttachments(event, { workDir: TEST_DIR });

    const content = event.messages[0].content as V2ContentPart[];
    expect(content.length).toBe(2);
    expect(content[0].type).toBe('text');
    expect((content[0].text as string).includes('What is in this image?')).toBe(
      true,
    );

    expect(content[1].type).toBe('text');
    const hint = content[1].text as string;
    expect(hint.includes('@observer')).toBe(true);
    expect(hint.includes('Image attachment detected')).toBe(true);
    expect(hint.includes('Saved to:')).toBe(true);
  });

  test('handles Uint8Array media data', () => {
    const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    const event = makeV2Event({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'media',
              mediaType: 'image/png',
              data: new Uint8Array(bytes),
              filename: 'shot.png',
            },
          ],
        },
      ],
    });

    processV2ImageAttachments(event, { workDir: TEST_DIR });
    const content = event.messages[0].content as V2ContentPart[];
    expect(content.length).toBe(1);
    expect(content[0].type).toBe('text');
    expect((content[0].text as string).includes('Saved to:')).toBe(true);
  });

  test('saves image under sanitized session directory', () => {
    const event = makeV2Event({
      sessionID: 'ses_v2-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          ],
        },
      ],
    });

    processV2ImageAttachments(event, { workDir: TEST_DIR });

    const sessionDirPath = join(TEST_DIR, '.opencode', 'images', 'ses_v2-test');
    expect(existsSync(sessionDirPath)).toBe(true);
    rmSync(sessionDirPath, { recursive: true, force: true });
  });

  test('skips non-user and non-image media messages', () => {
    const event = makeV2Event({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'media', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'media', mediaType: 'audio/mpeg', data: 'AAAA' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'plain question' }],
        },
      ],
    });

    processV2ImageAttachments(event, { workDir: TEST_DIR });

    expect((event.messages[0].content as V2ContentPart[]).length).toBe(1);
    expect((event.messages[0].content as V2ContentPart[])[0].type).toBe(
      'media',
    );
    expect((event.messages[1].content as V2ContentPart[]).length).toBe(1);
    expect((event.messages[2].content as V2ContentPart[]).length).toBe(1);
  });

  test('detects images by filename extension when mediaType is generic', () => {
    const event = makeV2Event({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'media',
              mediaType: 'application/octet-stream',
              data: TINY_PNG_BASE64,
              filename: 'screenshot.png',
            },
          ],
        },
      ],
    });

    processV2ImageAttachments(event, { workDir: TEST_DIR });
    const content = event.messages[0].content as V2ContentPart[];
    expect(content.length).toBe(1);
    expect(content[0].type).toBe('text');
  });
});

// ── V2 setup (mocked context) ─────────────────────────────────────

interface AgentLike {
  id?: string;
  name?: string;
  model?: { providerID: string; id: string; variant?: string };
  system?: string;
  description?: string;
  mode: string;
  hidden?: boolean;
  permissions: Array<unknown>;
}

/** Mirrors the V2 core AgentEditor.update upsert semantics. */
function makeMockEditor() {
  const agents = new Map<string, AgentLike>();
  return {
    agents,
    list: () => Array.from(agents.values()),
    get: (id: string) => agents.get(id),
    update: (id: string, fn: (a: AgentLike) => void) => {
      const current = agents.get(id) ?? { mode: 'primary', permissions: [] };
      if (!agents.has(id)) agents.set(id, current);
      fn(current);
    },
    remove: (id: string) => agents.delete(id),
  };
}

function makeMockCtx(options: Record<string, unknown> = {}) {
  const editor = makeMockEditor();
  const hooks: Record<string, (e: unknown) => void> = {};
  return {
    editor,
    hooks,
    ctx: {
      location: { directory: TEST_DIR },
      options,
      agent: {
        transform: async (
          fn: (e: ReturnType<typeof makeMockEditor>) => void,
        ) => {
          fn(editor);
        },
      },
      session: {
        hook: async (name: string, cb: (e: unknown) => void) => {
          hooks[name] = cb;
        },
      },
    },
  };
}

describe('createObserverSetup', () => {
  test('registers observer subagent with default model (upsert)', async () => {
    const { ctx, editor } = makeMockCtx();
    await createObserverSetup()(ctx as never);

    const observer = editor.agents.get(OBSERVER_AGENT_ID);
    expect(observer).toBeDefined();
    expect(observer?.mode).toBe('subagent');
    expect(observer?.model?.providerID).toBe('openai');
    expect(observer?.model?.id).toBe('gpt-4o');
    expect(observer?.system).toBe(OBSERVER_PROMPT_TEXT);
  });

  test('plugin options override default model', async () => {
    const { ctx, editor } = makeMockCtx({ model: 'google/gemini-2.5-flash' });
    await createObserverSetup()(ctx as never);

    const observer = editor.agents.get(OBSERVER_AGENT_ID);
    expect(observer?.model?.providerID).toBe('google');
    expect(observer?.model?.id).toBe('gemini-2.5-flash');
  });

  test('user-configured agent fields win over defaults', async () => {
    const { ctx, editor } = makeMockCtx();
    editor.agents.set(OBSERVER_AGENT_ID, {
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
      system: 'custom prompt',
      mode: 'primary',
      permissions: [],
    });
    await createObserverSetup()(ctx as never);

    const observer = editor.agents.get(OBSERVER_AGENT_ID);
    expect(observer?.model?.id).toBe('claude-sonnet-4-6'); // preserved
    expect(observer?.system).toBe('custom prompt'); // preserved
    expect(observer?.mode).toBe('subagent'); // enforced
  });

  test('context hook: injects system hint, strips media, no temperature by default', async () => {
    const { ctx, hooks } = makeMockCtx();
    await createObserverSetup()(ctx as never);
    const contextHook = hooks.context;
    expect(contextHook).toBeDefined();

    const event = makeV2Event({
      agent: 'build',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'media', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          ],
        },
      ],
    });

    contextHook(event);

    expect(event.system.length).toBe(2);
    expect(event.system[1].text).toBe(OBSERVER_SYSTEM_HINT);
    expect((event.messages[0].content as V2ContentPart[]).length).toBe(2); // text + hint
    expect((event.messages[0].content as V2ContentPart[])[1].text).toContain(
      'Saved to:',
    );

    // Temperature is NOT set by default — reasoning models (gpt-6-luna,
    // o-series) reject the parameter and fail the whole request.
    const observerEvent = makeV2Event({ agent: OBSERVER_AGENT_ID });
    contextHook(observerEvent);
    expect(observerEvent.options.temperature).toBeUndefined();

    // No duplicate hint
    contextHook(event);
    expect(event.system.length).toBe(2);

    // cleanup saved test images
    const sessionDirPath = join(TEST_DIR, '.opencode', 'images', 'ses_v2-test');
    rmSync(sessionDirPath, { recursive: true, force: true });
  });

  test('temperature: opt-in via plugin options, observer agent only', async () => {
    // Opt-in via ctx.options (config-file form)
    const { ctx, hooks } = makeMockCtx({ temperature: 0.1 });
    await createObserverSetup()(ctx as never);

    const observerEvent = makeV2Event({ agent: OBSERVER_AGENT_ID });
    hooks.context(observerEvent);
    expect(observerEvent.options.temperature).toBe(0.1);

    // Other agents untouched
    const buildEvent = makeV2Event({ agent: 'build' });
    hooks.context(buildEvent);
    expect(buildEvent.options.temperature).toBeUndefined();

    // An existing value is never overridden
    const preset = makeV2Event({ agent: OBSERVER_AGENT_ID });
    preset.options.temperature = 0.7;
    hooks.context(preset);
    expect(preset.options.temperature).toBe(0.7);
  });

  test('handles nested media.source runtime shape (opencode 2.0.x)', async () => {
    const { ctx, hooks } = makeMockCtx();
    await createObserverSetup()(ctx as never);

    const event = makeV2Event({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'media',
              filename: 'shot.png',
              media: {
                mediaType: 'image/png',
                kind: 'image',
                source: {
                  type: 'base64',
                  data: TINY_PNG_BASE64,
                  mediaType: 'image/png',
                },
              },
            },
          ],
        },
      ],
    });
    hooks.context(event);

    const content = event.messages[0].content as V2ContentPart[];
    expect(content.length).toBe(1);
    expect(content[0].type).toBe('text');
    expect((content[0].text as string).includes('Saved to:')).toBe(true);

    rmSync(join(TEST_DIR, '.opencode', 'images', 'ses_v2-test'), {
      recursive: true,
      force: true,
    });
  });
});
