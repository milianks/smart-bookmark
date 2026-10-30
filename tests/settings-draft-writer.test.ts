import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsDraftWriter } from '../components/settings-draft-writer';

afterEach(() => { vi.useRealTimers(); });

describe('settings draft writer', () => {
  it('coalesces typing into one write of the latest draft', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createSettingsDraftWriter(write);
    writer.schedule({ model: 'a' }, vi.fn());
    await vi.advanceTimersByTimeAsync(200);
    writer.schedule({ model: 'ab' }, vi.fn());
    await vi.advanceTimersByTimeAsync(200);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledExactlyOnceWith({ model: 'ab' });
  });

  it('flushes immediately before save or page close without writing twice', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createSettingsDraftWriter(write);
    writer.schedule({ model: 'latest' }, vi.fn());
    await writer.flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledExactlyOnceWith({ model: 'latest' });
  });

  it('serializes writes and recovers after a rejected save', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue(undefined);
    const writer = createSettingsDraftWriter(write);
    writer.schedule({ model: 'first' }, vi.fn());
    await expect(writer.flush()).rejects.toThrow('storage failed');
    writer.schedule({ model: 'second' }, vi.fn());
    await writer.flush();
    expect(write).toHaveBeenLastCalledWith({ model: 'second' });
  });
});
