import type { SettingsDraft } from '../types/domain';

export function createSettingsDraftWriter(write: (draft: SettingsDraft) => Promise<void>) {
  let pending: SettingsDraft | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending) {
      const draft = pending;
      pending = undefined;
      chain = chain.catch(() => undefined).then(() => write(draft));
    }
    return chain;
  }

  return {
    schedule(draft: SettingsDraft, onError: (reason: unknown) => void) {
      pending = draft;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush().catch(onError); }, 300);
    },
    flush,
  };
}
