// CLI 入口：node src/index.js <crawl|login|demo>
//  browser 启动时走 config.proxy（默认 Burp 127.0.0.1:8080），
//  整个爬虫的流量都进 Burp HTTP History。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { crawl } from './crawler.js';
import { login } from './login.js';
import { assist } from './assist.js';

const mode = process.argv[2] || 'crawl';
if (!['crawl', 'login', 'demo', 'resume', 'assist'].includes(mode)) {
  console.error('用法: node src/index.js <crawl|login|demo|resume|assist> [assist 起始URL]');
  process.exit(1);
}

const config = loadConfig(mode);
mkdirSync(path.join(config.outputDir, 'states'), { recursive: true });
const log = (msg) => console.log(msg);

// ---------- 演示模式：起本地零依赖站 ----------
let demoServer = null;
if (mode === 'demo') {
  const serverScript = path.join(PROJECT_ROOT, 'demo', 'server.js');
  demoServer = spawn(process.execPath, [serverScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 8000);
    demoServer.stdout.on('data', (d) => {
      if (String(d).includes('listening')) { clearTimeout(timer); resolve(); }
    });
    demoServer.on('exit', () => reject(new Error('演示服务器启动失败')));
  });
  log(`[demo] 演示站已启动: ${config.startUrl}`);
}

// ---------- 启动浏览器（走 Burp 代理） ----------
const launchOptions = {
  headless: config.headless,
  args: ['--disable-blink-features=AutomationControlled', ...(config.extraLaunchArgs || [])],
};
// 用真实浏览器内核（msedge/chrome）替代内置 Chromium：腾讯云 WAF 对内置 Chromium 指纹
// 直连会挂起（page.goto 120s 超时），真浏览器（用户实感"别的浏览器直接就开了"）秒开。
if (config.channel) launchOptions.channel = config.channel;
if (config.useProxy && config.proxy) launchOptions.proxy = config.proxy;
// assist 模式开 CDP 调试端口：MCP 工具（chrome-devtools-mcp/playwright-mcp）经它接管带登录态的浏览器
if (mode === 'assist') launchOptions.args.push(`--remote-debugging-port=${config.cdpPort ?? 9222}`);

const browser = await chromium.launch(launchOptions);
const resumeFlag = process.env.RESUME === '1' || mode === 'resume';

// 崩溃自愈：浏览器被误关/瞬断/msedge 崩溃 → 自动重启浏览器并从断点续跑。
// checkpoint 每个状态都落盘，崩溃最多丢一个状态的进度。
if (mode === 'login') {
  try { await login({ browser, config, log }); } finally { await browser.close().catch(() => {}); }
} else if (mode === 'assist') {
  try { await assist({ browser, config, log, url: process.argv[3] }); }
  finally { await browser.close().catch(() => {}); }
} else {
  const maxAttempts = config.crawlRetryMax ?? 6;
  for (let attempt = 1; ; attempt++) {
    let b = browser;
    if (attempt > 1) b = await chromium.launch(launchOptions); // 崩溃后重新拉起浏览器
    try {
      await crawl({ browser: b, config, log, resume: attempt > 1 || resumeFlag });
      await b.close().catch(() => {});
      break;
    } catch (e) {
      await b.close().catch(() => {});
      const msg = String(e.message || e).slice(0, 140);
      log(`[崩溃自愈] ${msg}（第 ${attempt} 次）→ 8s 后从断点续跑`);
      if (attempt >= maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
}
if (demoServer) demoServer.kill();
