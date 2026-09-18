import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSEResponse, sseEvent } from '../agents/_lib/runtime/sse.ts';

test('SSE responses frame events and terminate with DONE', async () => {
  const response = createSSEResponse(async function* () {
    yield sseEvent({ type: 'ping', ts: 1 });
  });
  const body = await response.text();

  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.match(body, /^data: \{"type":"ping","ts":1\}\n\n/);
  assert.match(body, /data: \[DONE\]\n\n$/);
});
