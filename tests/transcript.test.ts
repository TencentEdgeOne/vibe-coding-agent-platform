import assert from 'node:assert/strict';
import { mkdtemp, readFile as readDisk, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryBlobStore, transcriptBlobKey } from '../agents/_lib/session/store.ts';
import { downloadTranscript, uploadTranscript } from '../agents/_lib/session/transcript.ts';
import { projectTranscript } from '../agents/_lib/session/projection.ts';
import { applyStreamEvent } from '../shared/timeline.ts';
import type { PersistedActivityTurn } from '../shared/protocol.ts';

test('transcript upload and download stay a single JSONL file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-'));
  const source = path.join(directory, 'session.jsonl');
  const dest = path.join(directory, 'restored.jsonl');
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Make a todo list' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working on it.' },
          { type: 'tool_use', id: 'tool-1', name: 'write_project_file', input: { path: 'src/app.tsx', content: 'x' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'wrote src/app.tsx' },
        ],
      },
    }),
  ].join('\n');
  await writeFile(source, jsonl);

  const blobStore = createMemoryBlobStore();
  const context = { blobStore };
  await uploadTranscript({
    context,
    conversationId: 'conv-1',
    sessionId: 'sess-1',
    sourcePath: source,
  });
  const stored = await blobStore.get(transcriptBlobKey('sess-1'));
  assert.equal(stored, jsonl);

  const restored = await downloadTranscript({
    context,
    conversationId: 'conv-1',
    sessionId: 'sess-1',
    destPath: dest,
  });
  assert.equal(restored, true);
  assert.equal(await readDisk(dest, 'utf8'), jsonl);
  await rm(directory, { recursive: true, force: true });
});

test('JSONL projects into conversation turns with tool results folded in', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Build a page' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Writing files.' },
          { type: 'tool_use', id: 'call-1', name: 'write_project_file', input: { path: 'index.html', content: '<h1>Hi</h1>' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
        ],
      },
    }),
  ].join('\n');

  const turns = projectTranscript(jsonl, '/tmp/project');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, 'Build a page');
  assert.equal(turns[0].assistant, 'Writing files.');
  assert.equal(turns[0].activities.length, 2);
  assert.equal(turns[0].activities[0].kind, 'text');
  const tool = turns[0].activities[1];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.toolUseId, 'call-1');
    assert.equal(tool.status, 'completed');
    assert.match(tool.inputSummary || '', /index\.html/);
    assert.equal(tool.outputSummary, 'ok');
  }
});

test('live SSE events fold into the same turn model as a JSONL projection', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build a page',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, { type: 'text_segment', data: { text: 'Writing files.' } });
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 'call-1', name: 'write_project_file', inputSummary: 'index.html (8 chars)' },
  });
  turn = applyStreamEvent(turn, {
    type: 'tool_result',
    data: { id: 'call-1', ok: true, outputSummary: 'ok', status: 'completed' },
  });
  assert.equal(turn.activities.length, 2);
  const tool = turn.activities[1];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.toolUseId, 'call-1');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.outputSummary, 'ok');
  }
});

test('compaction re-uploads the local transcript file', async () => {
  const { readFile } = await import('node:fs/promises');
  const live = await readFile('agents/_lib/session/live.ts', 'utf8');
  assert.match(live, /subtype === 'compact_boundary'/);
  assert.match(live, /PostCompact:/);
  assert.match(live, /persistTranscript\(session\)/);
});
