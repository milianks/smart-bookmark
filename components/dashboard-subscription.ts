export function subscribeDashboard(refresh: () => Promise<void>, onError: (reason: unknown) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let port: chrome.runtime.Port | undefined;
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

  function onMessage(message: unknown) {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'state:changed') return;
    pending = true;
    schedule();
  }

  function reconnect() {
    // Reading lastError consumes Chrome's disconnect error when the worker disappears.
    void chrome.runtime.lastError;
    port?.onMessage.removeListener(onMessage);
    port?.onDisconnect.removeListener(reconnect);
    port = undefined;
    if (!disposed) reconnectTimer = setTimeout(connect, 1000);
  }

  function connect() {
    reconnectTimer = undefined;
    if (disposed) return;
    try {
      port = chrome.runtime.connect({ name: 'dashboard' });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(reconnect);
      pending = true;
      schedule();
    } catch (reason) {
      onError(reason);
      reconnect();
    }
  }

  connect();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    port?.onMessage.removeListener(onMessage);
    port?.onDisconnect.removeListener(reconnect);
    port?.disconnect();
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
