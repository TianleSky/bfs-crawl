// DFS 子树耗尽式遍历引擎（迭代式栈，每个状态一个独立标签页）
// - 每个状态独立标签页；探索子节点在"新标签页"里从根重放路径到达，父标签页永不被导航
// - 并行全览：每个节点的直接子节点分批(overviewBatchSize)并行开标签页触发，整批一起等渲染稳定
// - 同 URL 展开识别：子节点 URL 撞上已访问节点但交互面大幅增多(≥1.5x 且 ≥+10) → 判为菜单展开，建新状态深入
// - 全局 URL 级去重：子节点 URL 撞上任何已访问节点 → 判定"走错路"，不展开只记边（除非判定为展开）
// - 失败（前置缺失）节点保留 → 本状态耗尽后重试一轮 → 仍失败记录供人工处理
// - 每步落盘 checkpoint.json → 可断点续跑（crawl --resume）

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { collectInteractives, stepLabel, BASE_SELECTOR, isDangerous } from './discover.js';
import { fingerprint } from './state.js';
import { makeDialogs } from './dialogs.js';
import { makeTraffic } from './traffic.js';
import { buildHarFromTraffic } from './har.js';
import { clickElement, gotoStep, gotoWithRetry, replayPath } from './replay.js';
import { writeReport } from './report.js';

const INDENT = '   ';

// 归一化 URL：去 hash、去结尾斜杠，保留 query（不同实例/翻页仍是不同 URL）
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    const p = x.pathname.replace(/\/+$/, '');
    return x.origin + p + x.search;
  } catch { return u; }
}

// 去掉 query/hash 的 origin+path —— 用于判定"回到根页面"（腾讯云回首页可能带 from/tab 等参数）
function pathOnly(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    const p = x.pathname.replace(/\/+$/, '');
    return x.origin + p;
  } catch { return u; }
}

// 元素能否"直达"：href 是真实控制台链接（含相对路径 /svc、绝对 https://console.example.com/xxx），
// 非根(/)、非 JS、非外链(营销/文档页不入 includeUrlPattern)。可直达 → 直接 goto，
// 不用"重载根页面再重放父路径点击"——根的全览对 100+ 模块链接尤其关键，省掉 100 次根重载。
function resolveGotoUrl(el, config) {
  const href = (el.href || '').trim();
  if (!href || href === '/' || href === '#' || /^javascript:/i.test(href)) return null;
  let url;
  try { url = new URL(href, config.startUrl).href; } catch { return null; }
  if (config.includeUrlPattern && !new RegExp(config.includeUrlPattern).test(url)) return null;
  return url;
}

// 路径全为"直达"步骤（每步都带可导航 gotoUrl）→ 到达子节点无需从根加载 SPA，直接导航到末步 URL
function pureGotoPath(path) {
  return path.length > 0 && path.every((s) => s.gotoUrl);
}

export async function crawl({ browser, config, log, resume = false }) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    ...(config.storageState ? { storageState: config.storageState } : {}),
  });
  mkdirSync(path.join(config.outputDir, 'states'), { recursive: true });

  // 流量去重记录：method+URL+响应大小 去重，完整请求/响应包 → traffic.jsonl（不依赖代理/Burp）
  const traffic = config.captureTraffic ? makeTraffic(config, log) : null;
  if (traffic) traffic.attach(ctx);

  const visited = new Map();     // 指纹 fp -> id
  const visitedUrls = new Map(); // 归一化 URL -> id（全局去重，防"回到任何老节点"）
  const allStates = new Map();   // id -> state
  const stack = [];              // 当前 DFS 栈，每个元素有自己的 tab
  const pool = [];               // 预加载的根标签页池
  let bfsQueue = [];             // BFS 队列（order=bfs 时用，写入 checkpoint 以支持断点续跑）
  const backEdges = [];          // 重复路径记录 {from,label,to,url} → 全览图
  let counter = 0;
  let visitedHits = 0;
  const t0 = Date.now();
  const rootPath = pathOnly(config.startUrl); // 根页面的 origin+path（用于"回到根"特判）
  const cpPath = path.join(config.outputDir, 'checkpoint.json');

  // ================= 断点恢复 =================
  if (resume) {
    if (!existsSync(cpPath)) throw new Error(`没有 checkpoint 可恢复: ${cpPath}`);
    const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
    for (const [fp, id] of cp.visited) visited.set(fp, id);
    for (const [u, id] of (cp.visitedUrls || [])) visitedUrls.set(u, id);
    for (const s of cp.states) {
      s.interactives = s.interactives || [];
      s.processed = new Set(s.processed || []);
      s.children = s.children || [];
      s.failed = s.failed || [];
      s.retriedPass = false; // 每次续跑都再给一轮重试机会
      s.deepProcessed = new Set(s.deepProcessed || []);
      allStates.set(s.id, s);
    }
    if (cp.backEdges) { backEdges.length = 0; backEdges.push(...cp.backEdges); }
    counter = cp.nextId;
    visitedHits = cp.visitedHits || 0;
    log(`[断点] 恢复 ${allStates.size} 个状态，从 #${counter} 继续（${backEdges.length} 条重复路径已记录）`);

    // 上次已完整跑完 → 无需续跑（DFS 栈空 或 BFS 队列空）
    if (cp.stack.length === 0 && (cp.queue || []).length === 0 && cp.states.length > 0) {
      log('[断点] 上次已完整跑完，直接退出');
      await ctx.close();
      return;
    }

    // BFS：恢复队列（无父标签页栈）；DFS：重建整个栈的标签页（每个都从根重放路径到达）
    if (config.order === 'bfs') {
      bfsQueue = cp.queue || [];
      log(`[断点] BFS 恢复队列 ${bfsQueue.length} 个状态待处理`);
    } else {
      for (const id of cp.stack) {
        const st = allStates.get(id);
        if (!st) continue;
        const tab = await ctx.newPage();
        st.dialogs = makeDialogs(tab, config, log);
        await gotoWithRetry(tab, config.startUrl, config, log, '根');
        await st.dialogs.handle();
        await st.dialogs.stabilize();
        if (st.depth === 0) await settleRootSurface(tab, 30000);
        else await settleRootSurface(tab); // 根渲染完整后再重放路径，否则中间步骤可能找不到
        if (st.path.length > 0) await replayPath(tab, st.dialogs, st.path, config, log, { short: true });
        st.tab = tab;
        stack.push(st);
      }
    }
  }

  // ================= 全新开始：根状态 =================
  // BFS resume 时队列已恢复 → 不重建根（否则会产生孤儿重复根：建在 stack 里但 BFS 从不消费）
  if (stack.length === 0 && !bfsQueue.length) {
    const rootTab = await ctx.newPage();
    const rootDialogs = makeDialogs(rootTab, config, log);
    log(`[根] 打开 ${config.startUrl}`);
    await gotoWithRetry(rootTab, config.startUrl, config, log, '根');
    await rootDialogs.handle();
    await rootDialogs.stabilize();
    const root = await createState(rootTab, [], 0, null);
    if (root && root.id) { // createState 可能返回 {dup} 边对象，只有真正建出的状态才入栈
      root.tab = rootTab;
      root.dialogs = rootDialogs;
      root.processed = new Set();
      stack.push(root);
    } else if (root) {
      log('[根] 根页面与已有状态指纹重复，无法开始（请清空 output 或检查 storageState）');
      await ctx.close();
      return;
    }
    await saveCheckpoint();
  }

  // 预热根标签页池
  await refillPool();

  // ================= 主循环：先全览后深入（迭代式） =================
  // 每个栈元素 = 一个状态（标签页）。进入后分两阶段：
  //  阶段1 全览：把当前节点的全部直接子节点触发一遍（只建状态+记出边，标签页用完即关）
  //  阶段2 深入：按顺序取第一个未深入的子节点，重建标签页从根重放路径到达，入栈递归
  // 每个功能操作（新增/编辑/删除…）都是独立子元素，全览时都会形成一条完整触发路径。
  // ================= 主循环（按 config.order 选择遍历顺序） =================
  // DFS：先全览当前节点全部直接子节点，再深入第一个子节点（栈式，默认）
  // BFS：逐层推进——全览完当前层的所有状态再进入下一层，快速收集 URL 地图（队列式）
  if (config.order === 'bfs') {
    await bfsMainLoop();
  } else {
    await dfsMainLoop();
  }

  if (allStates.size > config.maxStates) log(`[上限] 达到 maxStates=${config.maxStates}，停止`);

  // ================= DFS 主循环（栈式：先全览后深入） =================
  // 每个栈元素 = 一个状态（标签页）。进入后分两阶段：
  //  阶段1 全览：把当前节点的全部直接子节点触发一遍（只建状态+记出边，标签页用完即关）
  //  阶段2 深入：按顺序取第一个未深入的子节点，重建标签页从根重放路径到达，入栈递归
  // 每个功能操作（新增/编辑/删除…）都是独立子元素，全览时都会形成一条完整触发路径。
  async function dfsMainLoop() {
    let iterations = 0;
    while (stack.length && allStates.size <= config.maxStates) {
      const st = stack[stack.length - 1];
      if (st.depth >= config.maxDepth) {
        log(`${INDENT.repeat(st.depth + 1)}└─ [已达最大深度 maxDepth=${config.maxDepth}]`);
        await closeState(st);
        continue;
      }

      // ---------- 阶段1：全览（分批并行触发全部直接子节点，含失败重试轮） ----------
      await overviewState(st);
      if (allStates.size >= config.maxStates) {
        log(`[上限] 达到 maxStates=${config.maxStates}，停止`);
        break;
      }
      if (++iterations % 10 === 0) log(`[进度] 已遍历 ${allStates.size} 个状态`);

      // ---------- 阶段2：全览完成 → 深入第一个未深入的子节点 ----------
      const nextChildId = (st.children || []).find((id) => !st.deepProcessed.has(id));
      if (nextChildId !== undefined) {
        st.deepProcessed.add(nextChildId);
        const cst = allStates.get(nextChildId);
        if (cst) {
          const lastLabel = cst.path.length ? stepLabel(cst.path[cst.path.length - 1]) : '';
          log(`${INDENT.repeat(st.depth + 1)}↘ 深入子节点 #${cst.id}${lastLabel ? ` [${lastLabel}]` : ''} → ${cst.title || cst.url}`);
          // 重建标签页到达：openPathTab 首步带 URL 直接 goto（跳过根 SPA），首步是触发才从根重放
          const bt = await openPathTab(cst.path);
          cst.dialogs = bt.dialogs;
          cst.tab = bt.tab;
          cst.processed = new Set();
          cst.retriedPass = false; // 深入后重新给一轮重试机会
          stack.push(cst);
          await saveCheckpoint();
          refillPool();
          continue;
        }
        // 状态不存在（异常）：跳过，继续找下一个
      }

      // 所有子节点都深入完 → 关闭本状态
      log(`${INDENT.repeat(st.depth)}└─ [关闭] #${st.id} 全览+子树已耗尽` + (st.failed.length ? `（${st.failed.length} 个失败节点留待人工处理）` : ''));
      await closeState(st);
    }
  }

  // ================= BFS 主循环（队列式：逐层全览，快速收集 URL 地图） =================
  // 不保持父标签页栈；每个状态的全览仍走并行批次，子标签页全部从根重放到达。
  async function bfsMainLoop() {
    // 初始队列：resume 已恢复的队列，或把初始栈（根）转成队列
    if (!bfsQueue.length) {
      while (stack.length) {
        const s = stack.pop();
        bfsQueue.push(s.id);
        await s.tab.close().catch(() => {}); // BFS 不保持父标签页，关闭释放
        delete s.tab;
        delete s.dialogs;
      }
    }
    let iterations = 0;
    while (bfsQueue.length && allStates.size <= config.maxStates) {
      const st = allStates.get(bfsQueue[0]);
      if (!st || st.depth >= config.maxDepth) { bfsQueue.shift(); continue; } // 跳过无效/超深
      // 先 peek 后 shift：overview 内部会落盘 checkpoint，此时队首仍是本状态 → 中断可精确续跑
      await overviewState(st);
      bfsQueue.shift();
      if (allStates.size >= config.maxStates) {
        log(`[上限] 达到 maxStates=${config.maxStates}，停止`);
        break;
      }
      if (++iterations % 10 === 0) log(`[进度] BFS 已遍历 ${allStates.size} 个状态`);
      for (const cid of st.children || []) {
        const cst = allStates.get(cid);
        if (cst && cst.depth < config.maxDepth && !bfsQueue.includes(cid)) bfsQueue.push(cid);
      }
      await saveCheckpoint();
    }
  }
  await ctx.close();
  writeReport({ allStates, visitedHits, config, elapsedMs: Date.now() - t0, log, backEdges });
  log(`\n===== 遍历完成 ===== 状态 ${allStates.size} | visited 命中 ${visitedHits} | 重复路径 ${backEdges.length}`);
  log(`全览图: ${path.join(config.outputDir, 'overview.html')}`);

  // ================= 阶段1 辅助：并行全览 =================

  // 把当前节点的全部直接子节点分批并行触发。
  // 每批：并行开标签页+重放父路径+点击 → 整批一起等渲染稳定（等待成本均摊到整批）→
  //       逐个范围检查/URL去重(含展开检测)/指纹去重 → 建状态 → 记边 → 关标签页。
  // 全览耗尽且存在失败节点 → 重试一轮（retriedPass，同原语义）。
  async function overviewState(st) {
    const batchSize = config.overviewBatchSize || 6;
    for (let pass = 0; pass < 2; pass++) {
      if (allStates.size >= config.maxStates) break; // 达到上限直接停，不再开下一批
      // pass 0 = 普通轮（从未处理过的）；pass 1 = 失败重试轮（仅当有失败且未重试过）
      if (pass === 1 && (st.retriedPass || st.failed.length === 0)) break;
      // 运行期再套一遍 skipTextPatterns：resume 恢复的旧交互面（采集时未标记）同样被拦，
      // 授权类按钮（前往授权/获取授权等）绝不会被点击。
      // 语义危险门禁（与采集时同一函数 isDangerous）：命中危险词但带只读导航 href 的放行
      const shouldSkip = (el) => el.skipped || isDangerous(el, config);
      const targets = pass === 0
        ? st.interactives.filter((el) => !shouldSkip(el) && !st.processed.has(el.selector))
        : st.failed.filter((el) => !shouldSkip(el) && !st.processed.has(el.selector));
      if (pass === 1) {
        st.retriedPass = true;
        st.processed = new Set();
        log(`${INDENT.repeat(st.depth + 1)}↻ 重试 ${targets.length} 个前置缺失节点`);
        await saveCheckpoint();
      }
      if (targets.length === 0) continue;

      for (let i = 0; i < targets.length; i += batchSize) {
        if (allStates.size >= config.maxStates) break;
        const batch = targets.slice(i, i + batchSize);

        // 1) 并行开标签页 + 重放父路径 + 点击（一个元素一个标签页，父标签页永不被导航）
        const opened = await Promise.all(batch.map(async (el) => {
          st.processed.add(el.selector);
          let tab = null;
          try {
            const gotoUrl = resolveGotoUrl(el, config);
            if (gotoUrl) {
              // 直达：真实控制台链接 → 直接 goto，不重载根/不重放父路径（快得多，且不会"找不到元素"）
              tab = await ctx.newPage();
              const dialogs = makeDialogs(tab, config, log);
              await gotoStep(tab, dialogs, gotoUrl, config, log, { short: true });
              return { tab, dialogs, el, gotoUrl };
            }
            // 无导航能力的廉价跳过：搜索框/外链（不入 includeUrlPattern）→ 不开标签页，记录供人工
            const href = (el.href || '').trim();
            const external = /^https?:\/\//i.test(href) && !new RegExp(config.includeUrlPattern).test(href);
            const useless = el.type === 'text' || el.type === 'input';
            if (external || useless) {
              el.skipped = true;
              log(`${INDENT.repeat(st.depth + 1)}⏭ 跳过 "${el.label || el.selector}"（${external ? '外链不入范围' : '输入框无导航'}）`);
              return null;
            }
            // 触发型元素（无 href 的按钮/radio/select → 展开菜单等）→ 到达状态页后点击。
            // openPathTab：首步带 URL 直接 goto（跳过根 SPA），首步是触发才从根重放。
            // tab 先赋给局部变量：click 失败时 catch 才能关掉它（之前是 null → 漏关）
            const bt = await openPathTab(st.path, true);
            tab = bt.tab;
            await clickElement(bt.tab, bt.dialogs, el, config, log);
            return { tab: bt.tab, dialogs: bt.dialogs, el };
          } catch (e) {
            const msg = String(e.message || e).slice(0, 120);
            log(`${INDENT.repeat(st.depth + 1)}✗ "${el.label}" 失败: ${msg}`);
            if (!st.failed.some((f) => f.selector === el.selector)) st.failed.push(el);
            await (tab && tab.close().catch(() => {}));
            return null;
          }
        }));
        const good = opened.filter(Boolean);

        // 2) 整批一起等渲染稳定（"等待久一点"，成本均摊到整批而不是逐页累加）
        await Promise.all(good.map(async ({ tab }) => {
          try { await settleOverviewTab(tab); } catch { /* 页面已关闭等异常交给下一步 */ }
        }));

        // 3) 逐个处理：范围检查 → URL去重(含展开) → 指纹去重 → 建状态 → 记边 → 关页
        for (const { tab, dialogs, el, gotoUrl } of good) {
          st.failed = st.failed.filter((f) => f.selector !== el.selector); // 点击成功即从失败名单移除
          try {
            const url = tab.url();
            // 跳出范围检查（防爬野）
            if (config.includeUrlPattern && !new RegExp(config.includeUrlPattern).test(url)) {
              log(`${INDENT.repeat(st.depth + 1)}↷ 跳出范围: ${url} (仅记录)`);
              await tab.close().catch(() => {});
              continue;
            }
            // URL 级全局去重：撞上任何已访问节点 → 走错路；但"同 URL 大幅展开"除外（菜单展开）
            let dupId;
            let expansion = false;
            if (config.dedupeByUrl) {
              dupId = visitedUrls.get(normalizeUrl(url));
              // 回到根页面（可能带 from/tab 等参数）→ 特判为重复
              if (dupId === undefined && pathOnly(url) === rootPath) dupId = visitedUrls.get(rootPath);
              if (dupId !== undefined) {
                if (!(await isExpansion(tab, dupId))) {
                  log(`${INDENT.repeat(st.depth + 1)}↺ 重复路径 → 已访问 #${dupId}（${url}）当前路走错，回到 #${st.id} 继续`);
                  visitedHits++;
                  backEdges.push({ from: st.id, label: el.label || '', to: dupId, url });
                  await tab.close().catch(() => {});
                  continue;
                }
                expansion = true;
                backEdges.push({ from: st.id, label: el.label || '', to: dupId, url, kind: 'expansion' }); // 信息性边：同 URL 判为菜单展开
              }
            }
            const step = gotoUrl ? { ...el, gotoUrl } : el; // 直达路径步骤携带 gotoUrl，深入时直接导航
            const child = await createState(tab, [...st.path, step], st.depth + 1, st.id, {
              preSettled: true,
              excludeEl: expansion ? el : undefined, // 展开态不再点触发按钮，避免再次收起菜单堵死子节点
            });
            if (child) {
              if (child.dup) {
                visitedHits++; // 指纹重复（边）
                backEdges.push({ from: st.id, label: el.label || '', to: child.dup, url });
              } else {
                st.children.push(child.id); // 全览：记录出边 → 全览图
                log(`${INDENT.repeat(st.depth + 1)}┈ 全览 #${st.id} → 子节点 #${child.id}`);
              }
            }
            await tab.close().catch(() => {}); // 全览用标签页即关，深入时再重建
            await saveCheckpoint();
          } catch (e) {
            const msg = String(e.message || e).slice(0, 120);
            log(`${INDENT.repeat(st.depth + 1)}✗ "${el.label}" 失败: ${msg}`);
            if (!st.failed.some((f) => f.selector === el.selector)) st.failed.push(el);
            await tab.close().catch(() => {});
            await saveCheckpoint();
          }
        }
        await closeStrayPages(); // 整批处理完：关掉任何漏网的残留页，防窗口越积越多
        refillPool();
      }
    }
  }

  // 同 URL 但交互面大幅增多 → 判定为"原地展开"（如腾讯云"全部功能"菜单）→ 允许建新状态深入。
  // 阈值：新数量 ≥ 已有 × expansionMinRatio(1.5) 且 ≥ 已有 + expansionMinDelta(10)。
  async function isExpansion(tab, dupId) {
    const existing = allStates.get(dupId);
    if (!existing) return false;
    try {
      const cnt = (await collectInteractives(tab, config)).length;
      const base = existing.interactives.length || 1;
      const ratio = config.expansionMinRatio ?? 1.5;
      const delta = config.expansionMinDelta ?? 10;
      const ok = cnt >= base * ratio && cnt >= base + delta;
      if (ok) log(`  [展开] 同URL但交互面大幅增加(${base}→${cnt})，视为菜单展开，继续探索`);
      return ok;
    } catch { return false; }
  }

  // 批次级整页等待：整批并行标签页一起等交互面稳定（比逐页串行等待更省时）
  async function settleOverviewTab(tab) {
    await waitForSurfaceSettle(tab, config.overviewSettleTimeoutMs || 25000);
  }

  // ================= 辅助 =================

  async function newRootTab(quiet = false) {
    const tab = await ctx.newPage();
    const dialogs = makeDialogs(tab, config, log);
    try {
      await tab.goto(config.startUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await dialogs.handle();
      await dialogs.stabilize();
      // 关键：等 SPA 渲染完整再交出去点，否则"云服务器/CDN"等还没渲染出来 → 找不到元素
      await settleRootSurface(tab, 0, quiet);
      return { tab, dialogs };
    } catch (e) {
      await tab.close().catch(() => {});
      throw e;
    }
  }

  async function refillPool() {
    try {
      while (pool.length < config.rootPoolSize) {
        pool.push(await newRootTab());
      }
    } catch (e) {
      // 退出阶段 ctx 已关闭触发的竞争属正常，不打印噪音
      const m = String(e.message || e);
      if (!/closed/i.test(m)) log(`[池] 根页面预热失败: ${m.slice(0, 80)}`);
    }
  }

  // 兜底：扫一遍当前所有页面，关闭任何没被池/栈/活动状态跟踪的残留页。
  // 前面的自清理能挡住已知泄漏，这个兜底兜住弹窗、第三方开窗等未知来源，杜绝窗口越积越多。
  async function closeStrayPages() {
    try {
      const keep = new Set();
      for (const p of pool) if (p.tab) keep.add(p.tab);
      for (const s of stack) if (s.tab) keep.add(s.tab);
      for (const s of allStates.values()) if (s.tab) keep.add(s.tab);
      for (const p of ctx.pages()) {
        if (!keep.has(p)) {
          log(`${INDENT.repeat((stack[stack.length - 1]?.depth ?? 0) + 1)}♻ 关闭残留页 ${(p.url() || '').slice(0, 60)}`);
          await p.close().catch(() => {});
        }
      }
    } catch { /* ctx 已关闭等退出阶段竞争，忽略 */ }
  }

  async function acquireRootTab(quiet = false) {
    if (pool.length > 0) return pool.pop(); // 复用已就绪的根页面
    return newRootTab(quiet);               // 池空兜底
  }

  // 到达一个状态页：首步带可导航 URL → 直接 goto，跳过根 SPA 加载（最快）。
  // 否则 → 才从根加载再重放路径。消除"先加载并 settle 根、随即又导航走"的纯浪费。
  // 自清理：任何一步抛错（断连/找不到元素/页面被关）都关闭已开的标签页再上抛，杜绝泄漏。
  async function openPathTab(path, quiet = false) {
    let tab = null;
    try {
      if (path.length && path[0].gotoUrl) {
        tab = await ctx.newPage();
        const dialogs = makeDialogs(tab, config, log);
        await gotoStep(tab, dialogs, path[0].gotoUrl, config, log, { short: true });
        for (let i = 1; i < path.length; i++) {
          const s = path[i];
          if (s.gotoUrl) await gotoStep(tab, dialogs, s.gotoUrl, config, log, { short: true });
          else await clickElement(tab, dialogs, s, config, log);
        }
        return { tab, dialogs };
      }
      const rt = await acquireRootTab(quiet);
      tab = rt.tab;
      if (path.length > 0) await replayPath(tab, rt.dialogs, path, config, log, { short: true });
      return rt;
    } catch (e) {
      if (tab) await tab.close().catch(() => {});
      throw e;
    }
  }

  // 滚动懒加载：触发懒加载内容（无限列表/虚拟滚动），扩充本状态交互面。
  // 状态内动作：不建新状态/不进队列。三闸门收敛：
  // 1) 步数硬顶 scrollMaxSteps（默认 8，0=关闭）；2) 交互面连续 2 次不再增长即停；3) 滚动条到底即停。
  async function scrollToExhaust(tab) {
    const maxSteps = config.scrollMaxSteps ?? 8;
    if (maxSteps <= 0) return;
    let prevCount = -1;
    let stableHits = 0;
    for (let step = 0; step < maxSteps; step++) {
      const r = await tab.evaluate(() => {
        const se = document.scrollingElement || document.documentElement;
        const before = se.scrollTop;
        se.scrollTop = before + window.innerHeight * 1.5;
        return { moved: se.scrollTop !== before, atEnd: se.scrollTop + window.innerHeight >= se.scrollHeight - 10 };
      }).catch(() => null);
      if (!r || !r.moved || r.atEnd) break;
      await new Promise((res) => setTimeout(res, 1000)); // 等懒加载触发
      const cnt = await tab.evaluate((sel) => document.querySelectorAll(sel).length, BASE_SELECTOR).catch(() => -1);
      if (cnt >= 0 && cnt === prevCount) {
        if (++stableHits >= 2) break;
      } else {
        stableHits = 0;
        prevCount = cnt;
      }
    }
    // 滚回顶部：后续点击有 scrollIntoView 不受影响，截图以顶部视角保持一致
    await tab.evaluate(() => { const se = document.scrollingElement || document.documentElement; se.scrollTop = 0; }).catch(() => {});
  }

  // SPA 动态加载：等"可见可点元素数量"连续多次一致再采集（抗轮询数字抖动，保首屏 JS 渲染完）
  // 注：腾讯云首页重度 SPA，JS 下载/解析期间 DOM 会"停顿"，稳定窗口必须足够长（3 次 × 1.2s），
  // 否则会撞上停顿窗口，把导航壳当成稳定页（实测：12 元素 vs 渲染完成 87 元素）。
  // 返回最终稳定时的元素数量（供"数量是否达标"判断）。
  async function waitForSurfaceSettle(page, timeoutMs) {
    const count = async () => {
      try { return await page.evaluate((sel) => document.querySelectorAll(sel).length, BASE_SELECTOR); }
      catch { return -1; }
    };
    let prev = await count();
    let stable = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const cur = await count();
      if (cur === prev) {
        stable++;
        if (stable >= 3) return cur; // 连续 3 个采样（~3.6s）无变化 → JS 渲染完成
      } else {
        stable = 0;
        prev = cur;
      }
    }
    return prev; // 超时兜底：用最后快照继续
  }

  // 根页面必须"渲染稳定 + 数量达标"才算就绪。
  // 数量过少 = 还在导航壳阶段（12 个 vs 渲染完 87+），光稳定不够（JS 解析停顿会被误判为稳定）。
  // 循环补等，直到数量达标或超时。新根标签页（含预加载池）和根状态都用它。
  async function settleRootSurface(tab, baseTimeoutMs = 0, quiet = false) {
    const base = baseTimeoutMs || config.surfaceSettleTimeoutMs || 15000;
    const min = config.rootMinInteractives ?? 15;
    // 控制台 SPA 的 JS 渲染很慢（曾见过 60s+ 才从"加载中"出界面），给足耐心：
    // 数量不达标就持续重采，直到 rootWaitMaxMs（默认 4 分钟）耗尽，而非 3 轮就放弃。
    const maxWait = config.rootWaitMaxMs ?? 240000;
    const deadline = Date.now() + maxWait;
    let cnt = await waitForSurfaceSettle(tab, base);
    let round = 0;
    while (cnt >= 0 && cnt < min && Date.now() < deadline) {
      const waited = Math.round((maxWait - (deadline - Date.now())) / 1000);
      if (!quiet) log(`  [根] 交互面偏少(${cnt}<${min})，可能未渲染完，再等 12s 重采…（已 ${waited}s / ${Math.round(maxWait / 1000)}s）`);
      cnt = await waitForSurfaceSettle(tab, 12000);
      round++;
    }
    return cnt;
  }

  async function closeState(st) {
    await st.tab.close().catch(() => {});
    stack.pop();
    if (stack.length) {
      // 不 bringToFront：不主动把窗口弹到前台，显示/最小化由用户自己控制
      if (config.rediscoverOnReturn) {
        try {
          stack[stack.length - 1].interactives = await collectInteractives(stack[stack.length - 1].tab, config);
        } catch { /* tab 可能已失效 */ }
      }
    }
    await saveCheckpoint();
    refillPool();
  }

  // opts.preSettled：标签页已在批次级整批等待过渲染稳定 → 跳过再次 settle（并行全览用）
  // opts.excludeEl：展开状态的触发按钮自身不再点击（否则会再次收起菜单，堵死整批子节点）
  async function createState(tab, pathSteps, depth, parentId, opts = {}) {
    const f = await fingerprint(tab);
    if (visited.has(f.fp)) return { dup: visited.get(f.fp) }; // 指纹已见 → 边
    const id = ++counter;
    const st = {
      id, depth, parentId, path: pathSteps,
      url: f.url, title: f.title, fp: f.fp,
      children: [], interactives: [], processed: new Set(),
      failed: [], retriedPass: false,
      deepProcessed: new Set(), // 已深入过的子节点 id（全览后逐个深入）
    };
    visited.set(f.fp, id);
    const nu = normalizeUrl(f.url);
    if (!visitedUrls.has(nu)) visitedUrls.set(nu, id); // 首个注册为准；同 URL 变体（如展开态）不覆盖根
    if (pathOnly(f.url) === rootPath && !visitedUrls.has(rootPath)) visitedUrls.set(rootPath, id); // 根页面（含带参变体）注册
    allStates.set(id, st);
    // SPA 内容靠 JS 异步渲染：先等交互面稳定，避免采集到"半成品"
    // 根页面重度加载给 30s + 数量达标补等；深层页面 15s
    if (!opts.preSettled) {
      if (depth === 0) await settleRootSurface(tab, 30000);
      else await waitForSurfaceSettle(tab, config.surfaceSettleTimeoutMs || 15000);
    }
    // 滚动懒加载扩充交互面：指纹已在上面算完（去重语义不受影响），滚动只影响采集广度
    await scrollToExhaust(tab);
    st.interactives = await collectInteractives(tab, config);
    if (opts.excludeEl) {
      const exSel = opts.excludeEl.selector;
      const exLabel = (opts.excludeEl.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
      st.interactives = st.interactives.filter((i) =>
        i.selector !== exSel && (i.label || '').replace(/\s+/g, ' ').trim().toLowerCase() !== exLabel);
    }

    const label = pathSteps.length === 0
      ? (st.title || st.url)
      : `[${stepLabel(pathSteps[pathSteps.length - 1])}] → ${st.title || st.url}`;
    const skipCount = st.interactives.filter((el) => el.skipped).length;
    log(`${INDENT.repeat(depth)}├─ #${id} d${depth} ${label}  (可点${st.interactives.length}${skipCount ? `, 跳过${skipCount}` : ''})`);
    await tab.screenshot({
      path: path.join(config.outputDir, 'states', `${String(id).padStart(3, '0')}.png`),
    }).catch(() => {});
    return st;
  }

  async function saveCheckpoint() {
    const payload = {
      savedAt: new Date().toISOString(),
      nextId: counter,
      visitedHits,
      visited: [...visited.entries()],
      visitedUrls: [...visitedUrls.entries()],
      backEdges,
      stack: stack.map((s) => s.id),
      queue: bfsQueue,
      states: [...allStates.values()].map((s) => ({
        id: s.id, depth: s.depth, parentId: s.parentId, path: s.path,
        url: s.url, title: s.title, fp: s.fp,
        children: s.children, processed: [...s.processed],
        interactives: s.interactives,
        failed: s.failed, retriedPass: s.retriedPass,
        deepProcessed: [...s.deepProcessed],
      })),
    };
    mkdirSync(config.outputDir, { recursive: true });
    writeFileSync(cpPath, JSON.stringify(payload));
    // 同步刷新 tree.json（用户可随时查看当前进度）
    writeReport({ allStates, visitedHits, config, elapsedMs: Date.now() - t0, log: () => {}, backEdges });
  }

  if (traffic) log(`[traffic] 去重流量记录完成：${traffic.stats.entries} 条 → ${traffic.stats.file}`);
  if (config.harCapture && traffic) {
    try {
      const n = buildHarFromTraffic(traffic.stats.file, path.join(config.outputDir, config.harPath || 'traffic.har'), { removeJsonl: true });
      log(`[har] 已生成去重 HAR ${n} 条 → ${config.harPath}（jsonl 已转 har，Burp 可直接导入）`);
    } catch (e) {
      log(`[har] 生成失败（保留 jsonl）: ${String(e.message || e).slice(0, 80)}`);
    }
  }
}
