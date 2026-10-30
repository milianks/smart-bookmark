const STATE_KEY = 'ai-bookmark-manager.state.v1';

export function subscribeDashboard(refresh: () => Promise<void>, onError: (reason: unknown) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;

  function schedule() {
    if (disposed || timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      running = true;
      void refresh().catch((reason: unknown) => { if (!disposed) onError(reason); }).finally(() => {
        running = false;
        if (pending) schedule();
      });
    }, 100);
  }

  function onChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STATE_KEY)) return;
    pending = true;
    schedule();
  }

  chrome.storage.onChanged.addListener(onChanged);
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    chrome.storage.onChanged.removeListener(onChanged);
  };
}

export function createLatestRefresh<T>(load: () => Promise<T>, apply: (value: T) => void, onError: (reason: unknown) => void): () => Promise<void> {
  let latest = 0;
  return async () => {
    const request = ++latest;
    try {
      const value = await load();
      if (request === latest) apply(value);
    } catch (reason) {
      if (request === latest) onError(reason);
    }
  };
}
