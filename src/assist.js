// LLM 补盲协助模式：带登录态起浏览器（开 CDP 调试端口）→ 打开指定页面 → 挂流量采集 → 挂起等 MCP 接管。
// 权限平移正解：不把登录态搬进 MCP 浏览器（HttpOnly cookie 导不出），
// 让 MCP 工具（chrome-devtools-mcp --browserUrl / playwright-mcp --cdp-endpoint）连这个已有登录态的浏览器。
// 流量独立落 output-assist/（与 crawl 产物隔离）；正常退出(Ctrl+C)自动转 HAR，强杀则事后补转。

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeTraffic } from './traffic.js';
import { buildHarFromTraffic } from './har.js';

export async function assist({ browser, config, log, url }) {
  const outputDir = path.resolve(config.outputDir, '..', 'output-assist');
  mkdirSync(outputDir, { recursive: true });
  const cfg = { ...config, outputDir };

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    ...(config.storageState ? { storageState: config.storageState } : {}),
  });
  const traffic = config.captureTraffic ? makeTraffic(cfg, log) : null;
  if (traffic) traffic.attach(ctx);

  const page = await ctx.newPage();
  const target = url || config.startUrl;
  log(`[assist] 打开 ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 })
    .catch((e) => log(`[assist] 打开失败（可忽略，MCP 可自行导航）: ${e.message}`));

  const port = config.cdpPort ?? 9222;
  log(`[assist] CDP 就绪: http://127.0.0.1:${port}`);
  log(`[assist] MCP 连接：chrome-devtools-mcp 加参数 --browserUrl http://127.0.0.1:${port}（playwright-mcp 用 --cdp-endpoint）`);
  log('[assist] 浏览器保持运行，等待 LLM 通过 MCP 补盲。Ctrl+C 结束并转 HAR。');

  const dump = () => {
    if (!traffic) return;
    try {
      const n = buildHarFromTraffic(
        path.join(outputDir, 'traffic.jsonl'),
        path.join(outputDir, 'traffic.har'),
        { removeJsonl: false },
      );
      log(`[assist] 已转 HAR ${n} 条 → output-assist/traffic.har`);
    } catch (e) { log(`[assist] HAR 转换失败: ${String(e.message || e).slice(0, 80)}`); }
  };
  process.on('SIGINT', () => { dump(); process.exit(0); });
  process.on('SIGTERM', () => { dump(); process.exit(0); });
  await new Promise(() => {}); // 挂起，直到进程结束
}
