import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLatestRefresh, subscribeDashboard } from '../components/dashboard-subscription';

const stateChange = { type: 'state:changed' };

function setup() {
  const addListener = vi.fn();
  const removeListener = vi.fn();
  const onDisconnect = { addListener: vi.fn(), removeListener: vi.fn() };
  const disconnect = vi.fn();
  const port = { onMessage: { addListener, removeListener }, onDisconnect, disconnect };
  const connect = vi.fn(() => port);
  vi.stubGlobal('chrome', { runtime: { connect } });
  return { addListener, removeListener, onDisconnect, disconnect, connect };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dashboard port notifications', () => {
  it('ignores unrelated changes, coalesces writes, and removes the listener on cleanup', async () => {
    vi.useFakeTimers();
    const { addListener, removeListener } = setup();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const cleanup = subscribeDashboard(refresh, vi.fn());
    const listener = addListener.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(100);
    refresh.mockClear();
    listener({ type: 'unrelated' });
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    listener(stateChange);
    listener(stateChange);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    listener(stateChange);
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
    listener(stateChange);
    await vi.advanceTimersByTimeAsync(100);
    listener(stateChange);
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
    listener(stateChange);
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(failure);
    listener(stateChange);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('reconnects after worker shutdown, refreshes, and cancels reconnect on cleanup', async () => {
    vi.useFakeTimers();
    const { connect, onDisconnect, disconnect } = setup();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const cleanup = subscribeDashboard(refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    onDisconnect.addListener.mock.calls[0]![0]();
    await vi.advanceTimersByTimeAsync(1100);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('retries a failed connection and cancels a pending retry when disposed', async () => {
    vi.useFakeTimers();
    const { connect, onDisconnect } = setup();
    const error = new Error('worker starting');
    connect.mockImplementationOnce(() => { throw error; });
    const onError = vi.fn();
    const cleanup = subscribeDashboard(vi.fn().mockResolvedValue(undefined), onError);
    expect(onError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    onDisconnect.addListener.mock.calls[0]![0]();
    cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
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
