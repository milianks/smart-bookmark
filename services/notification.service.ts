export interface NotificationPort {
  reviewNeeded(id: string): Promise<void>;
  processingFailed(id: string): Promise<void>;
  moved(id: string, title: string): Promise<void>;
}

export class ChromeNotificationService implements NotificationPort {
  constructor(
    private readonly notifications: typeof chrome.notifications = chrome.notifications,
    private readonly runtime: typeof chrome.runtime = chrome.runtime,
  ) {}

  async reviewNeeded(id: string): Promise<void> {
    await this.notifications.create(`review:${id}`, {
      type: 'basic',
      iconUrl: this.runtime.getURL('/icon/128.png'),
      title: 'AI 书签整理待确认',
      message: '有一条书签分类建议等待你确认。',
      priority: 0,
    });
  }

  async processingFailed(id: string): Promise<void> {
    await this.notifications.create(`failure:${id}`, {
      type: 'basic',
      iconUrl: this.runtime.getURL('/icon/128.png'),
      title: 'AI 书签整理未完成',
      message: '书签已保留原位。打开设置查看原因并重试。',
      priority: 0,
    });
  }

  async moved(id: string, title: string): Promise<void> {
    await this.notifications.create(`moved:${id}`, {
      type: 'basic',
      iconUrl: this.runtime.getURL('/icon/128.png'),
      title: '书签已自动归档',
      message: title.slice(0, 120),
      priority: 0,
    });
  }
}
