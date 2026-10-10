import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'AI Bookmark Manager',
    description: '在你收藏网页后，安全地帮助你整理书签。',
    version: '0.1.0',
    minimum_chrome_version: '134',
    permissions: ['bookmarks', 'storage', 'notifications', 'alarms', 'windows'],
    optional_host_permissions: [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
      'http://[::1]/*',
    ],
    action: {
      default_title: 'AI Bookmark Manager',
    },
  },
});
