import type { StorageChanges } from '../../lib/storage/repository';

const STATE_KEY = 'ai-bookmark-manager.state.v1';

/** Only the worker subscribes to storage; pages receive a constant-size invalidation. */
export function registerDashboardNotifications(
  runtime: { onConnect: Pick<typeof chrome.runtime.onConnect, 'addListener'> },
  storage: { onChanged: StorageChanges },
): () => void {
  const ports = new Set<chrome.runtime.Port>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (timer || ports.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const port of ports) {
        try { port.postMessage({ type: 'state:changed' }); }
        catch { ports.delete(port); }
      }
    }, 100);
  };
  runtime.onConnect.addListener((port) => {
    if (port.name !== 'dashboard') return;
    ports.add(port);
    port.onDisconnect.addListener(() => { ports.delete(port); });
    // Close the gap between the page's initial request and subscription registration.
    notify();
  });
  storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, STATE_KEY)) notify();
  });
  return notify;
}
