const path = require('path');
const os = require('os');
import { chromium } from 'playwright-core';

const outPath = process.argv[2] || path.join(os.tmpdir(), 'test-tool-shot.png');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const pages = contexts.flatMap((c) => c.pages());
console.log(
  '[shot] pages:',
  pages.map((p) => p.url())
);

const page = pages.find((p) => p.url().includes('index.html')) || pages[0];
if (!page) {
  console.error('[shot] no page found');
  process.exit(1);
}

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

await page.setViewportSize({ width: 1380, height: 880 });
await page.waitForTimeout(1500);
await page.screenshot({ path: outPath });

const text = await page.evaluate(() => document.body.innerText.slice(0, 600));
console.log('[shot] saved:', outPath);
console.log('[shot] body text:', JSON.stringify(text));
if (logs.length) console.log('[shot] console:\n' + logs.slice(-30).join('\n'));

await browser.close();