/**
 * Framework-agnostic scheduler behind the Inbox composer's "Undo Send"
 * delay: each queued message gets its own countdown, and fires exactly
 * once — either when the delay elapses or when the caller flushes early
 * (e.g. the agent switches conversations before the timer finishes).
 * Kept free of React so the timer/cancel semantics can be unit-tested
 * without rendering the composer.
 */

export type PendingSendCommitReason = "timeout" | "flush";

export interface PendingSendScheduleOptions {
  /** Called once a second with the seconds remaining (cosmetic — drives the countdown UI). */
  onTick: (secondsLeft: number) => void;
  /** Called exactly once: either the delay elapsed, or `flushAll()` fired it early. */
  onCommit: (reason: PendingSendCommitReason) => void;
}

export interface PendingSendQueueOptions {
  /** Delay before a scheduled item auto-commits, in ms. */
  delayMs: number;
  /** Tick interval, in ms. Defaults to 1000 (one UI tick per second). */
  tickMs?: number;
}

export interface PendingSendQueue {
  /** Start the countdown for `id`. */
  schedule: (id: string, options: PendingSendScheduleOptions) => void;
  /** Abort `id` without committing — a no-op if it already committed or was cancelled. */
  cancel: (id: string) => void;
  /** Commit every still-pending item immediately, in schedule order. */
  flushAll: () => void;
  /** True while `id` is still counting down. */
  isPending: (id: string) => boolean;
}

interface TimerEntry {
  timeoutId: ReturnType<typeof setTimeout>;
  intervalId: ReturnType<typeof setInterval>;
  onCommit: (reason: PendingSendCommitReason) => void;
}

export function createPendingSendQueue(
  options: PendingSendQueueOptions,
): PendingSendQueue {
  const { delayMs, tickMs = 1000 } = options;
  const timers = new Map<string, TimerEntry>();
  // Once an id has committed it can never fire again, even if `flushAll`
  // and the natural timeout land in the same tick.
  const committed = new Set<string>();

  function clear(id: string) {
    const entry = timers.get(id);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    clearInterval(entry.intervalId);
    timers.delete(id);
  }

  function commit(id: string, reason: PendingSendCommitReason) {
    if (committed.has(id)) return;
    const entry = timers.get(id);
    if (!entry) return;
    committed.add(id);
    clear(id);
    entry.onCommit(reason);
  }

  return {
    schedule(id, { onTick, onCommit }) {
      let secondsLeft = Math.ceil(delayMs / tickMs);
      const intervalId = setInterval(() => {
        secondsLeft = Math.max(0, secondsLeft - 1);
        onTick(secondsLeft);
      }, tickMs);
      const timeoutId = setTimeout(() => {
        commit(id, "timeout");
      }, delayMs);
      timers.set(id, { timeoutId, intervalId, onCommit });
    },
    cancel(id) {
      clear(id);
    },
    flushAll() {
      // Snapshot first — `commit` mutates `timers` as it goes.
      for (const id of Array.from(timers.keys())) {
        commit(id, "flush");
      }
    },
    isPending(id) {
      return timers.has(id);
    },
  };
}
