// 一次性手动登录 v2（无自动检测版）：
//   打开有头浏览器（走代理）→ 用户自行完成登录 → 用户自行关闭浏览器窗口
//   → 监听浏览器关闭事件，用关闭前最后一刻的 cookie 快照落盘 session.json
//
// 设计动机：buyin.jinritemai.com 这类营销首页站，登录前就有 SSO 静默握手
// cookie（bd_sso_*）和风控指纹 cookie（x-web-secsdk-uid），任何"新会话
// cookie"启发式都会秒误判、浏览器秒关。因此 v2 完全放弃自动检测：
//   - 用户关窗 = 唯一的"登录完成"信号，零误判；
//   - 每 1s 快照 cookie 到内存，关窗后用快照落盘（ctx 随浏览器销毁，不能事后取）；
//   - 10 分钟超时兜底：未关窗也保存当前态并退出。

import fs from 'node:fs';

export async function login({ browser, config, log }) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  log(`[登录] 打开 ${config.loginUrl}`);
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 })
    .catch((e) => log(`打开登录页失败: ${e.message}`));
  log('[登录] 请在浏览器窗口里完成登录（微信扫码 / 短信 / 账号密码）。');
  log('[登录] ★ 完成登录后请自行关闭浏览器窗口 —— 关窗瞬间自动保存登录态并结束。');
  log('[登录] 窗口保持打开期间绝不会自动退出；10 分钟无操作则兜底保存当前态。');

  // 每 1s 快照 cookie 到内存（浏览器关闭后 ctx 不可用，只能用关窗前的快照）
  let snapshot = [];
  const snapTimer = setInterval(() => {
    ctx.cookies().then((cs) => { snapshot = cs; }).catch(() => {});
  }, 1000);

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    clearInterval(snapTimer);
    try {
      // 优先试 ctx.storageState（浏览器还活着）；关窗后退化用手动快照拼 storageState
      await ctx.storageState({ path: config.storageState }).catch(() => {
        fs.writeFileSync(config.storageState, JSON.stringify({ cookies: snapshot, origins: [] }, null, 2));
      });
      log(`[登录] ✅ 登录态已保存到 ${config.storageState}（${snapshot.length || '(ctx)'} 条 cookie 快照）`);
    } catch (e) {
      log(`[登录] 保存失败: ${e.message}`);
    }
  };

  // 用户关窗（或浏览器进程退出）→ 保存并正常退出，绝不报错
  browser.on('disconnected', () => {
    save();
    process.exit(0);
  });

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline && !saved) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!saved) {
    log('[登录] 10 分钟超时，兜底保存当前态（若你还未登录，请重跑 login）。');
    await save();
    await browser.close().catch(() => {});
  }
}
