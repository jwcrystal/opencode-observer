/** Minimal Part type for image detection — mirrors OpenCode V1 message parts. */
export interface Part {
  type: string;
  text?: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

/** Message info (role, sessionID, etc.) — OpenCode V1 shape. */
export interface MessageInfo {
  role: string;
  sessionID?: string;
  [key: string]: unknown;
}

/** A message with its info and constituent parts — OpenCode V1 shape. */
export interface MessageWithParts {
  info: MessageInfo;
  parts: Part[];
}

/** Shape of the V1 `experimental.chat.messages.transform` hook output. */
export interface MessagesTransformOutput {
  messages: MessageWithParts[];
}

// ── OpenCode V2 shapes ────────────────────────────────────────────
// User images arrive as `{ type: "media", ... }` content parts. The
// published `@opencode/ai` types describe a flat `{ mediaType, data }`
// form, but opencode 2.0.x hands the session context hook a nested
// `{ media: { source: { type, data, mediaType }, mediaType } }` shape —
// the plugin supports both.

/**
 * V2 runtime media payload — nested `media` field on media content parts.
 */
export interface V2MediaPayload {
  mediaType?: string;
  kind?: string;
  source?: {
    type?: string; // "base64" | "url" | "path" | ...
    data?: string | Uint8Array;
    mediaType?: string;
    url?: string;
    path?: string;
  };
  [key: string]: unknown;
}

/** Minimal V2 content part — covers both flat (schema types) and nested (runtime) media shapes. */
export interface V2ContentPart {
  type: string;
  text?: string;
  mediaType?: string;
  data?: string | Uint8Array;
  filename?: string;
  media?: V2MediaPayload;
  [key: string]: unknown;
}

/** Minimal V2 message — `content` replaces the V1 `parts` array. */
export interface V2Message {
  id?: string;
  role: string;
  content: V2ContentPart[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** V2 system part — `ctx.session.hook("context")` edits these. */
export interface V2SystemPart {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

/** Minimal V2 model ref — `Agent.Info["model"]` without effect brands. */
export interface V2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/**
 * Minimal shape of the V2 `ctx.session.hook("context")` event —
 * only the mutable fields this plugin touches.
 */
export interface V2SessionContextEvent {
  sessionID?: string;
  agent?: string;
  system: V2SystemPart[];
  messages: V2Message[];
  options: Record<string, unknown>;
}
