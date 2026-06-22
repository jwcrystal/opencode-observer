import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_OBSERVER_MODEL,
  OBSERVER_SYSTEM_HINT,
  createObserverAgentConfig,
} from '../src/agent';
import { processImageAttachments } from '../src/image-hook';
import type { MessageWithParts } from '../src/types';

describe('agent', () => {
  test('createObserverAgentConfig uses provided model', () => {
    const config = createObserverAgentConfig('anthropic/claude-sonnet-4-6');
    expect(config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('createObserverAgentConfig defaults to gpt-4o when passed default', () => {
    const config = createObserverAgentConfig(DEFAULT_OBSERVER_MODEL);
    expect(config.model).toBe('openai/gpt-4o');
  });

  test('createObserverAgentConfig sets subagent mode', () => {
    const config = createObserverAgentConfig('openai/gpt-4o');
    expect(config.mode).toBe('subagent');
  });

  test('createObserverAgentConfig sets low temperature', () => {
    const config = createObserverAgentConfig('openai/gpt-4o');
    expect(config.temperature).toBe(0.1);
  });

  test('createObserverAgentConfig includes a description', () => {
    const config = createObserverAgentConfig('openai/gpt-4o');
    expect(config.description).toContain('Visual analysis');
  });

  test('OBSERVER_SYSTEM_HINT mentions @observer', () => {
    expect(OBSERVER_SYSTEM_HINT).toContain('@observer');
  });

  test('OBSERVER_SYSTEM_HINT is non-empty', () => {
    expect(OBSERVER_SYSTEM_HINT.length).toBeGreaterThan(10);
  });
});

describe('image-hook', () => {
  function makeMessage(
    role: string,
    parts: Array<{ type: string; [key: string]: unknown }>,
    sessionID?: string,
  ): MessageWithParts {
    return {
      info: { role, sessionID },
      parts: parts as MessageWithParts['parts'],
    };
  }

  test('no-op when no image parts present', () => {
    const output = {
      messages: [makeMessage('user', [{ type: 'text', text: 'hello' }])],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    expect(output.messages[0].parts.length).toBe(1);
    expect(output.messages[0].parts[0].type).toBe('text');
    expect(output.messages[0].parts[0].text).toBe('hello');
  });

  test('strips image parts and injects observer hint', () => {
    const output = {
      messages: [
        makeMessage('user', [
          { type: 'text', text: 'What is this?' },
          { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
        ]),
      ],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    const parts = output.messages[0].parts;
    expect(parts.length).toBe(2); // text + hint
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('What is this?');

    const hint = parts[1];
    expect(hint.type).toBe('text');
    expect(hint.text).toContain('@observer');
    expect(hint.text).toContain('Image attachment detected');
  });

  test('only processes user messages, not assistant', () => {
    const output = {
      messages: [
        makeMessage('assistant', [
          {
            type: 'image',
            url: 'data:image/png;base64,iVBORw0KGgo=',
          },
        ]),
      ],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    // Assistant messages with images should NOT be stripped
    expect(output.messages[0].parts.length).toBe(1);
    expect(output.messages[0].parts[0].type).toBe('image');
  });

  test('handles file-type image parts with mime', () => {
    const output = {
      messages: [
        makeMessage('user', [
          { type: 'file', mime: 'image/png', filename: 'screenshot.png' },
        ]),
      ],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    const parts = output.messages[0].parts;
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('@observer');
  });

  test('handles file-type image parts with extension-based detection', () => {
    const output = {
      messages: [makeMessage('user', [{ type: 'file', name: 'photo.jpg' }])],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    const parts = output.messages[0].parts;
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('text');
  });

  test('saves image data to disk and includes <PII type="CASE_ID" id="52"/> in hint', () => {
    // A minimal valid PNG (1x1 pixel, gray)
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const output = {
      messages: [
        makeMessage('user', [
          { type: 'image', url: tinyPng, filename: 'test.png' },
        ]),
      ],
    };

    processImageAttachments(output, { workDir: '/tmp/observer-test' });

    const hint = output.messages[0].parts[0].text as string;
    // Should mention that the file was saved
    expect(hint).toContain('Saved to:');
  });
});
