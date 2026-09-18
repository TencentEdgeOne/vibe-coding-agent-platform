const STREAM_FINISHED = Symbol('finished');
const STREAM_ABORTED = Symbol('aborted');

class AsyncValueQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

/** Fan in several SSE generators onto one connection without waiting for the slowest. */
export async function* mergeSseGenerators(
  generators: Array<AsyncGenerator<string>>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (generators.length === 0) return;
  if (generators.length === 1) {
    yield* generators[0];
    return;
  }

  const queue = new AsyncValueQueue<string | typeof STREAM_FINISHED | typeof STREAM_ABORTED>();
  let remaining = generators.length;
  const abort = () => queue.push(STREAM_ABORTED);
  signal?.addEventListener('abort', abort, { once: true });

  const pumps = generators.map(async (generator) => {
    try {
      for await (const chunk of generator) {
        if (signal?.aborted) return;
        queue.push(chunk);
      }
    } finally {
      remaining -= 1;
      if (remaining === 0) queue.push(STREAM_FINISHED);
    }
  });

  try {
    while (!signal?.aborted) {
      const item = await queue.next();
      if (item === STREAM_FINISHED || item === STREAM_ABORTED) return;
      yield item;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(pumps);
  }
}
