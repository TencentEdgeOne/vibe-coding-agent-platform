import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSdkQuery, stopSdkQuery } from '../agents/_lib/session/live.ts';

test('stop calls interrupt and leaves the SDK process up', async () => {
  let interrupted = false;
  const sdkAbort = new AbortController();
  const stopped = await stopSdkQuery({
    async interrupt() {
      interrupted = true;
    },
  }, sdkAbort);

  assert.equal(stopped, true);
  assert.equal(interrupted, true);
  assert.equal(sdkAbort.signal.aborted, false);
});

test('stop aborts the CLI when the traced query has no interrupt method', async () => {
  const sdkAbort = new AbortController();
  const tracedQuery = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  const stopped = await stopSdkQuery(tracedQuery, sdkAbort);

  assert.equal(stopped, true);
  assert.equal(sdkAbort.signal.aborted, true);
});

test('close aborts the CLI when the traced query has no close method', () => {
  const sdkAbort = new AbortController();
  const tracedQuery = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  closeSdkQuery(tracedQuery, sdkAbort);

  assert.equal(sdkAbort.signal.aborted, true);
});

test('close uses Query.close when the SDK object still has it', () => {
  let closed = false;
  const sdkAbort = new AbortController();
  closeSdkQuery({
    close() {
      closed = true;
    },
  }, sdkAbort);
  assert.equal(closed, true);
  assert.equal(sdkAbort.signal.aborted, false);
});
