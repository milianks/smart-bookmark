import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLatestRefresh, subscribeDashboard } from '../components/dashboard-subscription';

const stateChange = { 'ai-bookmark-manager.state.v1': {} };

function setup() {
  const addListener = vi.fn();
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener, removeListener } } });
  return { addListener, removeListener };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dashboard storage notifications', () => {
  it('ignores unrelated changes, coalesces writes, and removes the listener on cleanup', async () => {
    vi.useFakeTimers();
    const { addListener, removeListener } = setup();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const cleanup = subscribeDashboard(refresh, vi.fn());
    const listener = addListener.mock.calls[0]![0];
    listener(stateChange, 'sync');
    listener({ other: {} }, 'local');
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    listener(stateChange, 'local');
    listener(stateChange, 'local');
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    listener(stateChange, 'local');
    cleanup();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it('refreshes again after changes during an in-flight request without overlapping requests', async () => {
    vi.useFakeTimers();
    const { addListener } = setup();
    let resolve!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; })).mockResolvedValue(undefined);
    const cleanup = subscribeDashboard(refresh, vi.fn());
    const listener = addListener.mock.calls[0]![0];
    listener(stateChange, 'local');
    await vi.advanceTimersByTimeAsync(100);
    listener(stateChange, 'local');
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('reports refresh errors and remains subscribed for later updates', async () => {
    vi.useFakeTimers();
    const { addListener } = setup();
    const failure = new Error('worker unavailable');
    const onError = vi.fn();
    const refresh = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const cleanup = subscribeDashboard(refresh, onError);
    const listener = addListener.mock.calls[0]![0];
    listener(stateChange, 'local');
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(failure);
    listener(stateChange, 'local');
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });

});

describe('latest dashboard refresh', () => {
  it('does not replace newer state with an older response', async () => {
    let resolveOld!: (value: string) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce('new');
    const apply = vi.fn();
    const refresh = createLatestRefresh(load, apply, vi.fn());
    const old = refresh();
    await refresh();
    resolveOld('old');
    await old;
    expect(apply).toHaveBeenCalledExactlyOnceWith('new');
  });

  it('ignores an older request failure after a newer successful refresh', async () => {
    let rejectOld!: (reason: Error) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce('new');
    const onError = vi.fn();
    const refresh = createLatestRefresh(load, vi.fn(), onError);
    const old = refresh();
    await refresh();
    rejectOld(new Error('outdated error'));
    await old;
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports the latest failure and does not fall back to an outdated response', async () => {
    let resolveOld!: (value: string) => void;
    const failure = new Error('current failure');
    const load = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve; }))
      .mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const apply = vi.fn();
    const refresh = createLatestRefresh(load, apply, onError);
    const old = refresh();
    await refresh();
    resolveOld('old');
    await old;
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(apply).not.toHaveBeenCalled();
  });
});
