import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type {
  MessageWithParts,
  MessagesTransformOutput,
  Part,
  V2ContentPart,
  V2Message,
  V2SessionContextEvent,
} from './types';

// ── Debounce cleanup ──────────────────────────────────────────────
const lastCleanupByDir = new Map<string, number>();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic)$/i;

// ── Image detection ───────────────────────────────────────────────
/** V1: `{ type: "image" }` or `{ type: "file", mime/filename image }` parts. */
function isImagePart(p: Part): boolean {
  if (p.type === 'image') return true;
  if (p.type === 'file') {
    const mime = p.mime;
    if (mime?.startsWith('image/')) return true;
    const filename = p.filename ?? p.name;
    if (filename && IMAGE_EXT_RE.test(filename)) return true;
  }
  return false;
}

function mediaMime(p: V2ContentPart): string | undefined {
  const media = p.media;
  return (
    p.mediaType ?? media?.mediaType ?? media?.source?.mediaType ?? undefined
  );
}

/** V2: `{ type: "media", ... }` content parts carrying image mime or filename. */
function isImageMediaPart(p: V2ContentPart): boolean {
  if (p.type !== 'media') return false;
  const mime = mediaMime(p);
  if (mime?.startsWith('image/')) return true;
  if (p.media?.kind === 'image') return true;
  const filename = p.filename ?? p.media?.source?.path;
  return Boolean(filename && IMAGE_EXT_RE.test(filename));
}

// ── Data URL decoding ─────────────────────────────────────────────
function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

/**
 * Decode a V2 media part payload. Bytes may arrive as a base64 string
 * (optionally a data URL) or raw Uint8Array bytes, either flat on the part
 * (`data`) or nested under `media.source` (`source.type === "base64"`).
 */
function decodeMediaPart(
  p: V2ContentPart,
): { mime: string; data: Buffer } | null {
  const source = p.media?.source;
  const raw = p.data ?? (source?.type === 'base64' ? source.data : undefined);
  const mime = mediaMime(p) || 'image/png';
  if (raw === undefined) return null;
  if (raw instanceof Uint8Array) {
    return { mime, data: Buffer.from(raw) };
  }
  if (typeof raw === 'string') {
    if (raw.startsWith('data:')) {
      const decoded = decodeDataUrl(raw);
      if (decoded) return decoded;
    }
    return { mime, data: Buffer.from(raw, 'base64') };
  }
  return null;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
  };
  return map[mime] ?? '.png';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Cleanup ────────────────────────────────────────────────────────
function cleanupAllSessions(saveDir: string): void {
  const now = Date.now();
  const lastCleanup = lastCleanupByDir.get(saveDir) ?? 0;
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanupByDir.set(saveDir, now);

  const maxAge = 60 * 60 * 1000;
  const dirsToScan: string[] = [];

  try {
    for (const entry of readdirSync(saveDir, { withFileTypes: true })) {
      const fp = join(saveDir, entry.name);
      if (entry.isDirectory()) {
        dirsToScan.push(fp);
      } else {
        try {
          if (now - statSync(fp).mtimeMs > maxAge) unlinkSync(fp);
        } catch {
          // ignore stale file cleanup errors
        }
      }
    }
  } catch {
    // directory may not exist yet
  }

  for (const dir of dirsToScan) {
    try {
      let isEmpty = true;
      let allRemoved = true;
      for (const f of readdirSync(dir)) {
        isEmpty = false;
        const fp = join(dir, f);
        try {
          if (now - statSync(fp).mtimeMs > maxAge) {
            unlinkSync(fp);
          } else {
            allRemoved = false;
          }
        } catch {
          allRemoved = false;
        }
      }
      if (!isEmpty && allRemoved) {
        try {
          rmdirSync(dir);
        } catch {
          // directory may not be empty anymore
        }
      }
    } catch {
      // skip unreadable directories
    }
  }
}

// ── Unique file writer ────────────────────────────────────────────
function writeUniqueFile(
  dir: string,
  name: string,
  data: Buffer,
): string | null {
  const ext = extname(name);
  const base = basename(name, ext) || name;
  let candidate = join(dir, name);
  if (existsSync(candidate)) {
    return candidate;
  }

  let counter = 0;
  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      writeFileSync(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        counter += 1;
        candidate = join(dir, `${base}-${counter}${ext}`);
        continue;
      }
      return null;
    }
  }

  return null;
}

// ── Shared save logic ─────────────────────────────────────────────
/** Save decoded image bytes under `<original>-<sha1-8><ext>` (dedup-friendly). */
function saveDecodedImage(
  targetDir: string,
  filename: string | undefined,
  decoded: { mime: string; data: Buffer },
): string | null {
  const hash = createHash('sha1')
    .update(decoded.data)
    .digest('hex')
    .slice(0, 8);
  const sanitizedFilename = filename ? sanitizeFilename(filename) : undefined;
  const baseName = sanitizedFilename
    ? sanitizedFilename.replace(/\.[^.]+$/, '') || 'image'
    : 'image';
  const ext = sanitizedFilename
    ? extname(sanitizedFilename) || extFromMime(decoded.mime)
    : extFromMime(decoded.mime);
  return writeUniqueFile(targetDir, `${baseName}-${hash}${ext}`, decoded.data);
}

/** Ensure `.opencode/images/` and its `.gitignore` exist; returns the save dir. */
function ensureImagesDir(workDir: string): string {
  const saveDir = join(workDir, '.opencode', 'images');
  const gitignorePath = join(workDir, '.opencode', '.gitignore');
  try {
    mkdirSync(saveDir, { recursive: true });
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n');
  } catch {
    // non-fatal
  }
  return saveDir;
}

// ── Image text hint ───────────────────────────────────────────────
function buildObserverHint(savedPaths: string[]): string {
  const pathsText =
    savedPaths.length > 0 ? ` Saved to: ${savedPaths.join(', ')}` : '';
  return `[Image attachment detected.${pathsText} Your model may not support image input. Delegate to @observer with the file path(s) above so it can read the file with its read tool.]`;
}

// ── Public API ────────────────────────────────────────────────────

export interface ImageHookOptions {
  workDir: string;
}

/**
 * Process V1 messages: detect image parts, save them to disk, strip image
 * bytes, and insert a text hint suggesting @observer delegation.
 *
 * Called from V1 `experimental.chat.messages.transform`.
 */
export function processImageAttachments(
  output: MessagesTransformOutput,
  options: ImageHookOptions,
): void {
  const { workDir } = options;
  const saveDir = join(workDir, '.opencode', 'images');
  const messagesWithImages: Array<{
    msg: MessageWithParts;
    imageParts: Part[];
  }> = [];

  for (const msg of output.messages) {
    if (msg.info.role !== 'user') continue;
    const imageParts = msg.parts.filter(isImagePart);
    if (imageParts.length > 0) {
      messagesWithImages.push({ msg, imageParts });
    }
  }

  if (messagesWithImages.length === 0) {
    if (existsSync(saveDir)) cleanupAllSessions(saveDir);
    return;
  }

  ensureImagesDir(workDir);
  cleanupAllSessions(saveDir);

  for (const { msg, imageParts } of messagesWithImages) {
    const sessionSubdir = msg.info.sessionID
      ? sanitizeFilename(msg.info.sessionID)
      : undefined;
    const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch {
      // non-fatal
    }

    const savedPaths: string[] = [];
    for (const p of imageParts) {
      if (p.url) {
        const decoded = decodeDataUrl(p.url);
        if (decoded) {
          const filePath = saveDecodedImage(
            targetDir,
            p.filename ?? p.name,
            decoded,
          );
          if (filePath) savedPaths.push(filePath);
        }
      }
    }

    // Strip image parts and inject observer hint
    msg.parts = [
      ...msg.parts.filter((p) => !isImagePart(p)),
      { type: 'text', text: buildObserverHint(savedPaths) },
    ];
  }
}

/**
 * Process V2 session context: detect media image parts in user messages,
 * save them to disk, strip image bytes, and insert a text hint suggesting
 * @observer delegation.
 *
 * Called from the V2 `ctx.session.hook("context")` hook, which replaces
 * both V1 experimental transform hooks.
 */
export function processV2ImageAttachments(
  event: V2SessionContextEvent,
  options: ImageHookOptions,
): void {
  const { workDir } = options;
  const saveDir = join(workDir, '.opencode', 'images');
  const messagesWithImages: Array<{
    msg: V2Message;
    mediaParts: V2ContentPart[];
  }> = [];

  for (const msg of event.messages) {
    if (msg.role !== 'user') continue;
    const content = msg.content as V2ContentPart[];
    const mediaParts = content.filter(isImageMediaPart);
    if (mediaParts.length > 0) {
      messagesWithImages.push({ msg, mediaParts });
    }
  }

  if (messagesWithImages.length === 0) {
    if (existsSync(saveDir)) cleanupAllSessions(saveDir);
    return;
  }

  ensureImagesDir(workDir);
  cleanupAllSessions(saveDir);

  const sessionSubdir = event.sessionID
    ? sanitizeFilename(event.sessionID)
    : undefined;
  const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch {
    // non-fatal
  }

  for (const { msg, mediaParts } of messagesWithImages) {
    const content = msg.content as V2ContentPart[];
    const savedPaths: string[] = [];
    for (const p of mediaParts) {
      const decoded = decodeMediaPart(p);
      if (decoded) {
        const filePath = saveDecodedImage(targetDir, p.filename, decoded);
        if (filePath) savedPaths.push(filePath);
      }
    }

    // Strip image media parts and inject observer hint. Mutate the array
    // in place — Message instances may expose readonly properties.
    const kept = content.filter((p) => !isImageMediaPart(p));
    content.length = 0;
    content.push(...kept, {
      type: 'text',
      text: buildObserverHint(savedPaths),
    });
  }
}
