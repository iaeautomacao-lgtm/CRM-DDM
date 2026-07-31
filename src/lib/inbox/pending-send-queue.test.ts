import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingSendQueue } from "./pending-send-queue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPendingSendQueue", () => {
  it("commits with reason 'timeout' once the delay elapses", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const onCommit = vi.fn();
    const onTick = vi.fn();

    queue.schedule("a", { onTick, onCommit });
    expect(queue.isPending("a")).toBe(true);

    vi.advanceTimersByTime(9_999);
    expect(onCommit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(queue.isPending("a")).toBe(false);
  });

  it("ticks down once a second with the seconds remaining", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const onTick = vi.fn();

    queue.schedule("a", { onTick, onCommit: vi.fn() });

    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenNthCalledWith(1, 9);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenNthCalledWith(2, 8);
  });

  it("cancel() prevents the commit and stops the countdown", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const onCommit = vi.fn();
    const onTick = vi.fn();

    queue.schedule("a", { onTick, onCommit });
    vi.advanceTimersByTime(3000);
    queue.cancel("a");
    expect(queue.isPending("a")).toBe(false);

    vi.advanceTimersByTime(20_000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("commits at most once even if flushAll fires right as the timeout was due", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const onCommit = vi.fn();

    queue.schedule("a", { onTick: vi.fn(), onCommit });

    vi.advanceTimersByTime(10_000); // the setTimeout callback fires...
    queue.flushAll(); // ...a caller flushing right after must be a no-op

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("flushAll commits every still-pending item with reason 'flush', independently", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const committedA = vi.fn();
    const committedB = vi.fn();

    queue.schedule("a", { onTick: vi.fn(), onCommit: committedA });
    vi.advanceTimersByTime(4000);
    queue.schedule("b", { onTick: vi.fn(), onCommit: committedB });

    queue.flushAll();

    expect(committedA).toHaveBeenCalledExactlyOnceWith("flush");
    expect(committedB).toHaveBeenCalledExactlyOnceWith("flush");
    expect(queue.isPending("a")).toBe(false);
    expect(queue.isPending("b")).toBe(false);

    // Nothing left to fire — the underlying timers were cleared, not just
    // superseded, so letting time pass must not double-commit either one.
    vi.advanceTimersByTime(10_000);
    expect(committedA).toHaveBeenCalledOnce();
    expect(committedB).toHaveBeenCalledOnce();
  });

  it("flushAll is a no-op when nothing is pending", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    expect(() => queue.flushAll()).not.toThrow();
  });

  it("keeps independent timers per id", () => {
    const queue = createPendingSendQueue({ delayMs: 10_000 });
    const committedA = vi.fn();
    const committedB = vi.fn();

    queue.schedule("a", { onTick: vi.fn(), onCommit: committedA });
    vi.advanceTimersByTime(5000);
    queue.schedule("b", { onTick: vi.fn(), onCommit: committedB });

    vi.advanceTimersByTime(5000); // a's delay (10s) elapses; b has only run 5s
    expect(committedA).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(committedB).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000); // now b's delay elapses too
    expect(committedB).toHaveBeenCalledExactlyOnceWith("timeout");
  });
});
