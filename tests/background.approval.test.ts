import { afterEach, expect, it, vi } from 'vitest';

const approval = vi.hoisted(() => ({
  schedule: undefined as undefined | ((delay: number) => Promise<void>),
  resume: vi.fn(async () => {}),
}));
vi.mock('#imports', () => ({ defineBackground: (initialize: () => void) => initialize }));
vi.mock('../services/scan.service', () => ({
  ScanService: class {
    constructor(deps: { scheduleApprovalResume(delay: number): Promise<void> }) {
      approval.schedule = deps.scheduleApprovalResume;
    }
    resumeApprovals = approval.resume;
  },
}));

import { ChromeBookmarkService } from '../services/bookmark.service';
import { OrganizerService } from '../services/organizer.service';
import { emptyPersistedState } from '../types/domain';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('arms durable recovery before fast continuation and resumes on an alarm after timers are lost', async () => {
  vi.useFakeTimers();
  const event = () => ({ addListener: vi.fn() });
  const onAlarm = event();
  let release!: () => void;
  const alarmWrite = new Promise<void>((resolve) => { release = resolve; });
  const create = vi.fn(async () => alarmWrite);
  const state = emptyPersistedState();
  state.smartBookmarkRootId = 'smart-root';
  state.smartBookmarkInitialized = true;
  vi.stubGlobal('chrome', {
    bookmarks: { onCreated: event(), onRemoved: event(), onImportBegan: event(), onImportEnded: event(),
      onChanged: event(), onMoved: event(), onChildrenReordered: event() },
    storage: { onChanged: event(), local: {
      get: async () => ({ 'ai-bookmark-manager.state.v1': state }),
      set: async () => {}, setAccessLevel: async () => {},
    } },
    runtime: { onConnect: event(), onStartup: event(), onInstalled: event(), onMessage: event() },
    notifications: { onClicked: event() },
    alarms: { create, onAlarm },
  });
  vi.spyOn(ChromeBookmarkService.prototype, 'initializeSmartBookmarkRoot').mockResolvedValue({
    rootId: 'smart-root', title: '智能书签', created: false, defaultsCreated: 0,
  });
  vi.spyOn(OrganizerService.prototype, 'resume').mockResolvedValue();
  const { default: initialize } = await import('../entrypoints/background');
  (initialize as unknown as () => void)();
  await vi.advanceTimersByTimeAsync(0);
  approval.resume.mockClear();

  const scheduling = approval.schedule!(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(approval.resume).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith('ai-bookmark-manager.approve', { when: expect.any(Number) });
  release();
  await scheduling;
  await vi.advanceTimersByTimeAsync(1);
  expect(approval.resume).toHaveBeenCalledOnce();

  await approval.schedule!(1);
  vi.clearAllTimers();
  onAlarm.addListener.mock.calls[0]![0]({ name: 'ai-bookmark-manager.approve' });
  expect(approval.resume).toHaveBeenCalledTimes(2);
});
