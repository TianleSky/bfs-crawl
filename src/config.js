import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig(mode = 'crawl') {
  const configPath = path.join(PROJECT_ROOT, 'config.json');
  if (!existsSync(configPath)) throw new Error(`缺少配置文件: ${configPath}`);
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));

  if (mode === 'demo') {
    // 演示模式：本地零依赖站，不走代理、用无头窗口，快且不依赖外部
    cfg.useProxy = false;
    cfg.startUrl = 'http://127.0.0.1:3100/';
    cfg.includeUrlPattern = '127\\.0\\.0\\.1:3100/';
    cfg.headless = true;
    cfg.storageState = undefined;
    cfg.stabilize = { ...cfg.stabilize, quietMs: 250, timeoutMs: 4000, settleMs: 200 };
    cfg.rediscoverOnReturn = false; // 演示站静态，无需重发现
    cfg.rootMinInteractives = 0;     // 演示站首屏即完整，无需"交互面偏少"重采
    cfg.outputDir = 'output-demo';   // 与真实爬取隔离，demo 绝不覆盖真实 checkpoint/截图
  }

  cfg.outputDir = path.isAbsolute(cfg.outputDir) ? cfg.outputDir : path.join(PROJECT_ROOT, cfg.outputDir);
  if (cfg.storageState) {
    cfg.storageState = path.isAbsolute(cfg.storageState) ? cfg.storageState : path.join(PROJECT_ROOT, cfg.storageState);
  }
  // 环境变量覆盖（不改配置文件即可调节范围/测断点）
  if (process.env.MAX_STATES) cfg.maxStates = Number(process.env.MAX_STATES);
  if (process.env.MAX_DEPTH) cfg.maxDepth = Number(process.env.MAX_DEPTH);
  // BFS_PROXY：每次任务指向当次 SRC listener 监听端口（mitmproxy 实时入库），
  // 例：http://127.0.0.1:24307。设置后强制启用代理，覆盖 config.json 的 proxy.server。
  if (process.env.BFS_PROXY) {
    cfg.useProxy = true;
    cfg.proxy = { ...(cfg.proxy || {}), server: process.env.BFS_PROXY };
  }
  // maxStates=0/未设置 → 不设上限（跑到队列耗尽为止）
  if (!cfg.maxStates) cfg.maxStates = Infinity;
  return cfg;
}
