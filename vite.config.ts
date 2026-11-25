import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative paths, so the build works under any GitHub Pages sub-path.
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-180.png'],
      manifest: {
        name: 'Balderdash',
        short_name: 'Balderdash',
        description: 'A companion for playing the dictionary bluffing game in person.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#F4EFE3',
        theme_color: '#F4EFE3',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // Interface files only. No runtime caching: game data is never stored
        // by the service worker.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5196, strictPort: true },
  preview: { port: 4196, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/db/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
