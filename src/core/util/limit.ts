/** Runs at most `concurrency` tasks at once. Errors propagate to the caller of each task. */
export function pLimit(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** Maps with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

/** Serializes async work per key, so two writers of one file never interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
