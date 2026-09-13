/**
 * Batches streamed deltas so React renders once a frame, not once a token.
 *
 * Both streaming surfaces called `setState` per token and rebuilt their whole
 * list inside it. A single reply at sixty tokens a second is sixty array
 * rebuilds and sixty re-renders of every message; the agents panel fans a task
 * out to several agents at once, so it multiplies that by the number running.
 * The work is quadratic in the length of the answer, which is why replies feel
 * fine at first and slow down as they grow.
 *
 * Coalescing on a timer rather than `requestAnimationFrame`: rAF is paused in a
 * background window, and a task left running while the user works elsewhere
 * would stall instead of streaming. Sixteen milliseconds is a frame at 60Hz, so
 * the visible behaviour matches while the guarantee is unconditional.
 */

export interface StreamBuffer<K extends string> {
  /** Records a delta. The flush happens on the next tick, not now. */
  push(key: K, delta: string): void;
  /**
   * Flushes anything pending immediately.
   *
   * Required when a stream ends: without it the last deltas sit in the buffer
   * until a timer that may never be worth waiting for, and the final words of
   * an answer go missing.
   */
  finish(): void;
  /** Drops pending work and cancels the timer. For unmount. */
  dispose(): void;
}

export interface StreamBufferOptions {
  /** Overridable so tests need no real clock. */
  schedule?: (run: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

const FRAME_MS = 16;

export function createStreamBuffer<K extends string>(
  /** Receives only the deltas accumulated since the last flush. */
  onFlush: (batch: Map<K, string>) => void,
  options: StreamBufferOptions = {},
): StreamBuffer<K> {
  const schedule = options.schedule ?? ((run) => setTimeout(run, FRAME_MS));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const pending = new Map<K, string>();
  let handle: unknown = null;

  function flush(): void {
    handle = null;
    if (pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();
    onFlush(batch);
  }

  return {
    push(key, delta) {
      if (!delta) return;
      pending.set(key, (pending.get(key) ?? '') + delta);
      handle ??= schedule(flush);
    },
    finish() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      flush();
    },
    dispose() {
      if (handle !== null) cancel(handle);
      handle = null;
      pending.clear();
    },
  };
}
