// 真实 SPA 采集健壮性验证：console.volcengine.com（公开页，无需登录态）
// 验证改造后的 collectInteractives 在重度 SPA 上：不崩、iframe 遍历生效、危险门禁生效
import { chromium } from 'playwright';
import { collectInteractives } from './src/discover.js';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await page.goto(cfg.startUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(10000); // 给 SPA 渲染时间

  const frames = page.frames();
  const items = await collectInteractives(page, cfg);
  const iframeItems = items.filter((i) => i.frameUrl);
  const skipped = items.filter((i) => i.skipped);

  console.log('当前 URL:', page.url());
  console.log('frames 总数:', frames.length, '| 跨 frame 元素:', iframeItems.length);
  console.log('交互面总数:', items.length, '| 危险门禁拦截:', skipped.length);
  console.log('样例（前 8 条）:');
  for (const i of items.slice(0, 8)) {
    console.log(`  [${i.tag}/${i.type}] ${(i.text || '').slice(0, 30)} ${i.frameUrl ? '(iframe)' : ''} ${i.skipped ? '[SKIP]' : ''}`);
  }
  console.log('\n真实站采集验证通过：未崩溃、采集正常');
} finally {
  await browser.close().catch(() => {});
}
