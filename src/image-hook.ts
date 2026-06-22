import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MessageWithParts, MessagesTransformOutput, Part } from './types';

// ── Debounce cleanup ──────────────────────────────────────────────
const lastCleanupByDir = new Map<string, number>();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ── Image detection ───────────────────────────────────────────────
function isImagePart(p: Part): boolean {
  if (p.type === 'image') return true;
  if (p.type === 'file') {
    const mime = p.mime;
    if (mime?.startsWith('image/')) return true;
    const filename = p.filename ?? p.name;
    if (
      filename &&
      /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic)$/i.test(filename)
    )
      return true;
  }
  return false;
}

// ── Data URL decoding ─────────────────────────────────────────────
function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
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
 * Process messages: detect image parts, save them to disk, strip image
 * bytes, and insert a text hint suggesting @observer delegation.
 *
 * Called from `experimental.chat.messages.transform`.
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

  // Ensure save directory and .gitignore exist
  const gitignorePath = join(workDir, '.opencode', '.gitignore');
  try {
    mkdirSync(saveDir, { recursive: true });
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n');
  } catch {
    // non-fatal
  }

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
      const url = p.url;
      const filename = p.filename ?? p.name;
      if (url) {
        const decoded = decodeDataUrl(url);
        if (decoded) {
          const hash = createHash('sha1')
            .update(decoded.data)
            .digest('hex')
            .slice(0, 8);
          const sanitizedFilename = filename
            ? sanitizeFilename(filename)
            : undefined;
          const baseName = sanitizedFilename
            ? sanitizedFilename.replace(/\.[^.]+$/, '') || 'image'
            : 'image';
          const ext = sanitizedFilename
            ? extname(sanitizedFilename) || extFromMime(decoded.mime)
            : extFromMime(decoded.mime);
          const name = `${baseName}-${hash}${ext}`;
          const filePath = writeUniqueFile(targetDir, name, decoded.data);
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
