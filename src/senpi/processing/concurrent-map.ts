/** Inputs for an order-preserving asynchronous map. */
export interface ConcurrentMapOptions<Input, Output> {
  /** Maximum number of mapping operations permitted to run simultaneously. */
  readonly concurrency: number;
  /** Asynchronous mapping operation. */
  readonly map: (item: Input, index: number) => Promise<Output>;
}

interface IndexedResult<Output> {
  readonly index: number;
  readonly value: Output;
}

/**
 * Map asynchronous work through a finite worker pool while preserving order.
 *
 * @param items - Deterministically ordered input values.
 * @param options - Mapping operation and concurrency ceiling.
 * @returns Results at the corresponding input indexes.
 */
export async function mapConcurrentOrdered<Input, Output>(
  items: readonly Input[],
  options: ConcurrentMapOptions<Input, Output>
): Promise<Output[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('concurrency must be a positive safe integer');
  }

  const entries = items.entries();
  const workerCount = Math.min(options.concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    const completed: IndexedResult<Output>[] = [];
    for (;;) {
      const next = entries.next();
      if (next.done) return completed;
      const [index, item] = next.value;
      completed.push({ index, value: await options.map(item, index) });
    }
  });
  const completed = (await Promise.all(workers)).flat();
  completed.sort((left, right) => left.index - right.index);
  return completed.map(result => result.value);
}
