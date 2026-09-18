import type { AgentContext } from '../runtime/context.ts';
import { createReadStream, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveConversationId } from '../runtime/request.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { getBlobStore, getConversationRecord, patchConversationRecord, transcriptBlobKey } from './store.ts';

const TRANSCRIPT_WATCH_MS = 250;

const TRANSCRIPT_WARN_BYTES = 32 * 1024 * 1024;

function toNodeReadable(value: unknown): Readable | null {
  if (!value) return null;
  if (value instanceof Readable) return value;
  if (typeof (value as ReadableStream).getReader === 'function') {
    return Readable.fromWeb(value as import('node:stream/web').ReadableStream);
  }
  if (typeof value === 'string') {
    return Readable.from([value]);
  }
  return null;
}

export async function downloadTranscript(options: {
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike };
  conversationId: string;
  sessionId: string;
  destPath: string;
}): Promise<boolean> {
  const store = getBlobStore(options.context);
  const body = await store.get(transcriptBlobKey(options.sessionId), { type: 'stream' });
  const readable = toNodeReadable(body);
  if (!readable) return false;

  await mkdir(path.dirname(options.destPath), { recursive: true });
  await pipeline(readable, createWriteStream(options.destPath));
  return true;
}

export async function uploadTranscript(options: {
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike };
  conversationId: string;
  sessionId: string;
  sourcePath: string;
}): Promise<void> {
  const info = await stat(options.sourcePath).catch(() => null);
  if (!info) {
    console.warn('[transcript] local file missing; skip upload', options.sourcePath);
    return;
  }
  if (info.size >= TRANSCRIPT_WARN_BYTES) {
    console.warn('[transcript] large session file', {
      sessionId: options.sessionId,
      bytes: info.size,
    });
  }

  const store = getBlobStore(options.context);
  await store.set(
    transcriptBlobKey(options.sessionId),
    Readable.toWeb(createReadStream(options.sourcePath)) as unknown as ReadableStream,
  );
  await patchConversationRecord(options.context, options.conversationId, {
    claudeSessionId: options.sessionId,
    transcriptPath: options.sourcePath,
  });
}

export async function readTranscriptText(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath, 'utf8');
}

export type TranscriptLocateOptions = {
  configDir?: string;
  cwd?: string;
};

/** Claude persists JSONL at `$CLAUDE_CONFIG_DIR/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

export function resolveClaudeTranscriptPath(
  sessionId: string,
  options?: TranscriptLocateOptions & { explicitPath?: string },
): string {
  const explicit = (options?.explicitPath || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (!sessionId) return explicit;

  const configDir = (options?.configDir || '').trim() || '/tmp/.claude';
  const cwd = (options?.cwd || '').trim() || process.cwd();
  const conventional = path.join(
    configDir,
    'projects',
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
  if (existsSync(conventional)) return conventional;

  const legacy = path.join(configDir, 'sessions', `${sessionId}.jsonl`);
  if (existsSync(legacy)) return legacy;

  const projects = path.join(configDir, 'projects');
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return explicit || conventional;
}

/**
 * The Claude JSONL file is the only history this product keeps. Resume and the
 * Session tab both read it here so they cannot drift onto a second copy.
 */
export async function loadTranscriptJsonl(
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike },
  conversationId: string,
  livePath = '',
  locate?: TranscriptLocateOptions & { sessionId?: string },
): Promise<string> {
  const record = await getConversationRecord(context, conversationId);
  const sessionId = locate?.sessionId || record.claudeSessionId || '';
  const resolved = resolveClaudeTranscriptPath(sessionId, {
    explicitPath: livePath || record.transcriptPath,
    configDir: locate?.configDir,
    cwd: locate?.cwd,
  });
  if (resolved && existsSync(resolved)) {
    return readTranscriptText(resolved);
  }
  if (sessionId) {
    const dest = resolved || path.join('/tmp/.claude/sessions', `${sessionId}.jsonl`);
    const restored = await downloadTranscript({
      context,
      conversationId,
      sessionId,
      destPath: dest,
    });
    if (restored) return readTranscriptText(dest);
  }
  return '';
}

function jsonResponse(obj: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export type LiveTranscriptRef = {
  path?: string;
  sessionId?: string;
  active?: boolean;
};

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** GET /transcript — JSONL snapshots while the live file is being written. */
export async function createTranscriptStreamResponse(
  context: AgentContext,
  resolveLive: (conversationId: string) => LiveTranscriptRef | null,
): Promise<Response> {
  const { conversationId } = resolveConversationId(context);
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  return createSSEResponse(async function* (signal) {
    let lastSignature = '';
    let watching = true;

    while (!signal?.aborted && watching) {
      const live = resolveLive(conversationId);
      // This loop exists to notice the session id another request writes, so
      // it is the one reader that must bypass the per-request record memo.
      const record = !live?.sessionId || !live?.path
        ? await getConversationRecord(context, conversationId, { refresh: true })
        : null;
      const sessionId = live?.sessionId || record?.claudeSessionId || '';
      const transcriptPath = resolveClaudeTranscriptPath(sessionId, {
        explicitPath: live?.path || record?.transcriptPath,
      });
      const jsonl = await loadTranscriptJsonl(context, conversationId, transcriptPath, { sessionId });
      const data = {
        ok: true as const,
        conversation_id: conversationId,
        sessionId,
        transcriptPath,
        jsonl,
        live: Boolean(live?.active),
      };
      const signature = `${data.sessionId}\0${data.transcriptPath}\0${data.live}\0${data.jsonl}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        yield sseEvent({ type: 'transcript', data });
      }
      watching = Boolean(live?.active);
      if (!watching) break;
      await sleep(TRANSCRIPT_WATCH_MS, signal);
    }
  }, context?.request?.signal);
}
