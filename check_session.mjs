// 诊断：用 storageState 打开 /home，看落在哪、有多少可交互元素
import { chromium } from 'playwright';
import { BASE_SELECTOR } from './src/discover.js';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ignoreHTTPSErrors: true,
  storageState: 'output/session.json',
});
const page = await ctx.newPage();
await page.goto('https://console.volcengine.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());

const stats = await page.evaluate((sel) => {
  const els = document.querySelectorAll(sel);
  const visible = [...els].filter((el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const byTag = {};
  for (const el of visible) {
    const key = el.tagName.toLowerCase() + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '');
    byTag[key] = (byTag[key] || 0) + 1;
  }
  const texts = visible.slice(0, 40).map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)).filter(Boolean);
  return { total: els.length, visible: visible.length, byTag, texts };
}, BASE_SELECTOR);
console.log('BASE_SELECTOR 匹配:', JSON.stringify(stats, null, 2));

await page.screenshot({ path: 'output/debug_home.png', fullPage: false });
console.log('screenshot: output/debug_home.png');
await browser.close();
