import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { OBSERVER_SYSTEM_HINT } from '../src/agent';

// ── Mock PluginInput ───────────────────────────────────────────────
const TEST_MODEL = 'openai/gpt-4o'; // Change vision-capable model
const TEST_DIR = join(import.meta.dir, '..');

function makeMockInput(): PluginInput {
  return {
    client: {} as never,
    project: {} as never,
    directory: TEST_DIR,
    worktree: TEST_DIR,
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL('http://localhost:0'),
    $: { cwd: () => TEST_DIR, env: () => ({}) } as never,
  };
}

function partAsRecord(p: unknown): Record<string, unknown> {
  return p as Record<string, unknown>;
}

describe('plugin loading', () => {
  test('loads and returns a plugin factory', async () => {
    const mod = await import('../dist/index.js');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  test('factory returns hooks with all three keys', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    expect(hooks).toBeDefined();
    expect(typeof hooks.config).toBe('function');
    expect(typeof hooks['experimental.chat.messages.transform']).toBe('function');
    expect(typeof hooks['experimental.chat.system.transform']).toBe('function');
  });

  test('config hook registers observer subagent with gpt-4o model', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const config = hooks.config as (c: Record<string, unknown>) => Promise<void>;

    // Default model (no override)
    const cfg: Record<string, unknown> = {};
    await config(cfg);
    const agent = cfg.agent as Record<string, unknown> | undefined;
    expect(agent).toBeDefined();
    const observer = agent?.observer as Record<string, unknown> | undefined;
    expect(observer).toBeDefined();
    expect(observer?.model).toBe('openai/gpt-4o');
    expect(observer?.mode).toBe('subagent');
    expect(observer?.temperature).toBe(0.1);

    // Override with TEST_MODEL
    const cfg2: Record<string, unknown> = {
      agent: { observer: { model: TEST_MODEL } },
    };
    await config(cfg2);
    const observer2 = ((cfg2.agent as Record<string, unknown>).observer ?? {}) as Record<string, unknown>;
    expect(observer2.model).toBe(TEST_MODEL);
    expect(observer2.mode).toBe('subagent');
    expect(observer2.temperature).toBe(0.1);
  });

  test('messages.transform strips image parts and injects hint', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const transform = hooks['experimental.chat.messages.transform'] as (
      _input: unknown,
      output: { messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>;

    const output = {
      messages: [
        {
          info: { role: 'user' },
          parts: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
      ],
    };

    await transform({}, output);

    const parts = output.messages[0].parts;
    expect(parts.length).toBe(2);
    expect(partAsRecord(parts[0]).text).toBe('What is in this image?');

    const hint = partAsRecord(parts[1]);
    expect(hint.type).toBe('text');
    expect((hint.text as string)).toContain('@observer');
    expect((hint.text as string)).toContain('Image attachment detected');
  });

  test('messages.transform skips non-user messages', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const transform = hooks['experimental.chat.messages.transform'] as (
      _input: unknown,
      output: { messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>;

    const output = {
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
      ],
    };

    await transform({}, output);

    expect(output.messages[0].parts.length).toBe(1);
    expect(partAsRecord(output.messages[0].parts[0]).type).toBe('image');
  });

  test('system.transform injects observer hint', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const sysTransform = hooks['experimental.chat.system.transform'] as (
      _input: unknown,
      output: { system: string[] },
    ) => Promise<void>;

    const output = { system: ['You are a helpful assistant.'] };
    await sysTransform({}, output);

    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain('@observer');
  });

  test('system.transform does not duplicate hint', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const sysTransform = hooks['experimental.chat.system.transform'] as (
      _input: unknown,
      output: { system: string[] },
    ) => Promise<void>;

    const output = { system: ['You are a helpful assistant.', OBSERVER_SYSTEM_HINT] };
    await sysTransform({}, output);

    expect(output.system.length).toBe(2);
  });

  test('messages.transform saves image data to disk and includes path in hint', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const transform = hooks['experimental.chat.messages.transform'] as (
      _input: unknown,
      output: { messages: Array<{ info: { role: string; sessionID?: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>;

    // Minimal valid 1x1 PNG
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const output = {
      messages: [
        {
          info: { role: 'user', sessionID: 'test-session-123' },
          parts: [
            { type: 'image', url: tinyPng, name: 'test-image.png' },
          ],
        },
      ],
    };

    await transform({}, output);

    const hint = partAsRecord(output.messages[0].parts[0]);
    expect((hint.text as string)).toContain('Saved to:');

    // Verify the file was actually saved to disk
    const imagesDir = join(TEST_DIR, '.opencode', 'images', 'test-session-123');
    expect(existsSync(imagesDir)).toBe(true);

    // Clean up test artifacts
    rmSync(imagesDir, { recursive: true, force: true });
  });

  test('messages.transform handles file-type image parts', async () => {
    const mod = await import('../dist/index.js');
    const hooks: Hooks = await mod.default(makeMockInput());
    const transform = hooks['experimental.chat.messages.transform'] as (
      _input: unknown,
      output: { messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> },
    ) => Promise<void>;

    const output = {
      messages: [
        {
          info: { role: 'user' },
          parts: [
            { type: 'file', mime: 'image/png', name: 'screenshot.png' },
          ],
        },
      ],
    };

    await transform({}, output);

    const parts = output.messages[0].parts;
    expect(parts.length).toBe(1);
    expect(partAsRecord(parts[0]).type).toBe('text');
    expect((partAsRecord(parts[0]).text as string)).toContain('@observer');
  });
});
