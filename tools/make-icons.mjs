// Renders public/icon.svg to the PNG sizes the web manifest and iOS want.
// Run: node tools/make-icons.mjs   (uses the Edge that Playwright drives)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: new URL(`../public/icon-${size}.png`, import.meta.url).pathname.slice(1) });
  await page.close();
}
await browser.close();
