import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getBlobStore, patchConversationRecord, transcriptBlobKey } from './store.ts';

const TRANSCRIPT_WARN_BYTES = 32 * 1024 * 1024;

function toNodeReadable(value: unknown): Readable | null {
  if (!value) return null;
  if (value instanceof Readable) return value;
  if (typeof (value as ReadableStream).getReader === 'function') {
    return Readable.fromWeb(value as ReadableStream<Uint8Array>);
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
