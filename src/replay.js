// 点击执行（含 checkbox/radio/select/文本框）+ 路径重放
// 子标签页构造：goto(根) → 重放父路径各步 → 点击目标元素 → 弹窗自动处理 → 稳定

import { locate, collectInteractives } from './discover.js';

async function doClick(page, dialogs, loc, el, config, log) {
  await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  if (el.type === 'checkbox') {
    if (!(await loc.isChecked().catch(() => false))) {
      try { await loc.check({ force: true }); }
      catch { try { await loc.click({ force: true }); } catch (e) { throw e; } }
    }
    return;
  }
  if (el.type === 'radio') {
    try { await loc.check({ force: true }); }
    catch { await loc.click({ force: true }); }
    return;
  }
  if (el.type === 'select') {
    const n = await loc.locator('option').count().catch(() => 0);
    if (n > 1) {
      try { await loc.selectOption({ index: 1 }); } catch { await loc.click({ force: true }); }
    } else {
      await loc.click({ force: true });
    }
    return;
  }
  if (el.type === 'text') {
    const v = config.fillTextValue || 'test';
    try { await loc.fill(v); }
    catch { await loc.click(); await page.keyboard.type(v); }
    return;
  }
  try { await loc.click({ timeout: 8000 }); }
  catch {
    try { await loc.click({ force: true, timeout: 8000 }); }
    catch (e) { throw e; }
  }
}

export async function clickElement(page, dialogs, el, config, log, opts = {}) {
  if (config.autoAgreeConsent !== false) await dialogs.handle(); // 点击前先清协议层：异步弹出的同意书可能正盖着目标
  const loc = locate(page, el);
  if ((await loc.count().catch(() => 0)) === 0) {
    const fb = page.locator(el.fallbackSelector);
    if ((await fb.count().catch(() => 0)) === 0) {
      await relocateByLabel(page, dialogs, el, config, log, opts);
      return;
    }
    await doClick(page, dialogs, fb, el, config, log);
  } else {
    await doClick(page, dialogs, loc, el, config, log);
  }
  await dialogs.handle();
  await dialogs.stabilize(opts.short);
}

// SPA 重渲染后保存的结构路径可能失效 → 重新发现页面，按文本/label 匹配重定位再点。
// 例："云服务器"在侧边栏和快捷入口都有副本，任一都可通向同一产品控制台。
async function relocateByLabel(page, dialogs, el, config, log, opts) {
  const target = (el.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const meaningful = el.label && el.label !== el.tag; // label 只是标签名（如空按钮→"button"）时跳过
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let hit = null;
  if (meaningful && target) {
    // 晚渲染元素（根 SPA 首屏只有前十几个，导航面板/菜单里的元素后面才出来）→ 多次重试重发现
    const retries = config.relocateRetries ?? 4;
    for (let i = 0; i <= retries && !hit; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));
      try {
        const items = await collectInteractives(page, config);
        hit = items.find((i) => norm(i.label) === target || norm(i.text) === target)
          || (target.length >= 4 ? items.find((i) => norm(i.label).includes(target) || norm(i.text).includes(target)) : null);
      } catch { /* 单次重发现失败继续下一轮 */ }
    }
  }
  if (!hit) throw new Error(`找不到元素: ${el.label} (${el.fallbackSelector})`);
  log(`  [重定位] "${el.label}" 原选择器失效，按 label 重新定位成功`);
  const loc = locate(page, hit);
  await doClick(page, dialogs, loc, hit, config, log);
  await dialogs.handle();
  await dialogs.stabilize(opts.short);
}

// 直达：元素带 gotoUrl（真实控制台 href 解析出的完整 URL）时，直接导航过去，
// 不再"重放父路径 + 点击"。根的全览对 100+ 模块链接尤其关键——省掉 100 次根页面重载。
export async function replayPath(page, dialogs, path, config, log, opts = {}) {
  for (const step of path) {
    if (step.gotoUrl) await gotoStep(page, dialogs, step.gotoUrl, config, log, opts);
    else await clickElement(page, dialogs, step, config, log, opts);
  }
}

// 直连对腾讯云偶发瞬时断连（ERR_CONNECTION_CLOSED / RESET / 超时）→ 重试，避免一次抽风杀整个爬取。
// 返回时页面已成功到达目标 URL（domcontentloaded）。超过重试上限或非瞬时错误则抛出。
export async function gotoWithRetry(page, url, config, log, label = '') {
  const retries = config.gotoRetries ?? 3;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const transient = /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_SOCKET|ERR_NETWORK|ERR_ABORTED|ERR_HTTP2|ERR_SSL|ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|Timeout/i.test(msg);
      if (i >= retries || !transient) throw e;
      log && log(`  [重试] ${label || url.slice(0, 50)} 断连 (${i + 1}/${retries}): ${msg.slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function gotoStep(page, dialogs, url, config, log, opts = {}) {
  if (config.autoAgreeConsent !== false) await dialogs.handle(); // 导航前先清协议层
  await gotoWithRetry(page, url, config, log);
  await dialogs.handle();
  await dialogs.stabilize(opts.short);
}
