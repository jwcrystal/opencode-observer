/** Minimal Part type for image detection — mirrors OpenCode message parts. */
export interface Part {
  type: string;
  text?: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

/** Message info (role, sessionID, etc.). */
export interface MessageInfo {
  role: string;
  sessionID?: string;
  [key: string]: unknown;
}

/** A message with its info and constituent parts. */
export interface MessageWithParts {
  info: MessageInfo;
  parts: Part[];
}

/** Shape of the `experimental.chat.messages.transform` hook output. */
export interface MessagesTransformOutput {
  messages: MessageWithParts[];
}
