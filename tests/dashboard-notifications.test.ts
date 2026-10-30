import { afterEach, expect, it, vi } from 'vitest';
import { registerDashboardNotifications } from '../entrypoints/background/dashboard';

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => { listeners.add(listener); },
    emit: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
  };
}

afterEach(() => vi.useRealTimers());

it('coalesces storage and bookmark invalidations into constant-size port messages', async () => {
  vi.useFakeTimers();
  const onConnect = event<(port: chrome.runtime.Port) => void>();
  const onChanged = event<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const notify = registerDashboardNotifications(
    { onConnect },
    { onChanged },
  );
  const onDisconnect = event<() => void>();
  const postMessage = vi.fn();
  const port = { name: 'dashboard', postMessage, onDisconnect } as unknown as chrome.runtime.Port;
  onConnect.emit({ ...port, name: 'other' });
  notify();
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  onConnect.emit(port);
  await vi.advanceTimersByTimeAsync(100);
  postMessage.mockClear();
  onChanged.emit({ other: {} }, 'local');
  onChanged.emit({ 'ai-bookmark-manager.state.v1': {} }, 'sync');
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  for (let index = 0; index < 5000; index += 1) {
    onChanged.emit({ 'ai-bookmark-manager.state.v1': { newValue: { jobs: Array(5000).fill(index) } } }, 'local');
  }
  notify();
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'state:changed' });
  expect(JSON.stringify(postMessage.mock.calls[0]![0])).toHaveLength(24);
  onDisconnect.emit();
  notify();
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledTimes(1);
});
