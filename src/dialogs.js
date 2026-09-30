// 协议弹窗处理 + 原生 dialog + 页面稳定
// 每个标签页一个实例。协议弹窗流程：滚到底→勾选复选框→点同意→确认关闭。
// 升级：整页"同意书/协议层"（其他元素全灰、不匹配 modalSelectors）也能自动检测并同意，
//      以及"同意"按钮被禁用、需滚动到底+勾选后才解锁的场景。

export function makeDialogs(page, config, log) {
  let inflight = 0;
  let lastActivity = Date.now();

  page.on('request', () => { inflight++; lastActivity = Date.now(); });
  page.on('requestfinished', () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); });
  page.on('requestfailed', () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); });
  page.on('dialog', (d) => { log(`  [原生弹窗] ${d.type()} → accept`); d.accept().catch(() => {}); });

  async function findVisibleModal() {
    for (const sel of config.modalSelectors) {
      try {
        const loc = page.locator(sel);
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) return el;
        }
      } catch { /* 选择器无效则跳过 */ }
    }
    return null;
  }

  // 整页"同意书/协议层"检测：不匹配 modalSelectors 的整页遮罩（其他都灰）。
  // 特征：容器覆盖视口 ≥50% + 文本含协议关键词 + 内含同意关键词按钮。
  // 返回该容器的结构路径 locator（供 Node 侧做滚动/勾选/点击），找不到返回 null。
  // 取"包含元素最少"的那个，避免命中 body / 外层壳。
  async function findConsentOverlay() {
    const sel = await page.evaluate((cfg) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const consentRe = new RegExp(cfg.consentKeywords.join('|'), 'i');
      const agreeRe = new RegExp(cfg.agreeKeywords.join('|'), 'i');
      const structOf = (el) => {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
          const tag = cur.tagName.toLowerCase();
          let idx = 1;
          for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
            if (sib.tagName.toLowerCase() === tag) idx++;
          }
          parts.unshift(`${tag}:nth-of-type(${idx})`);
          cur = cur.parentElement;
        }
        return ['html', ...parts].join(' > ');
      };
      const isBigBox = (el) => {
        // 不用 offsetParent（position:fixed 遮罩的 offsetParent 是 null，但它是可见的）
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          && r.width >= innerWidth * 0.5
          && r.height >= innerHeight * 0.5;
      };
      const hasAgreeBtn = (root) => {
        return Array.from(root.querySelectorAll('button, [role="button"], a, input[type="submit"]')).some((b) => {
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return agreeRe.test(clean(b.innerText || b.getAttribute('aria-label') || b.value || ''));
        });
      };
      const candidates = [];
      for (const el of document.querySelectorAll('div, section, form, main, [role="dialog"], body')) {
        if (!isBigBox(el)) continue;
        const text = clean(el.innerText || '').slice(0, 4000);
        if (!consentRe.test(text)) continue;
        if (!hasAgreeBtn(el)) continue;
        candidates.push({ el, size: el.querySelectorAll('*').length });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => a.size - b.size);
      return structOf(candidates[0].el);
    }, {
      consentKeywords: config.consentKeywords || ['协议', '条款', '用户协议', '隐私政策', '同意书', '服务协议', '我已阅读', 'terms', 'consent', 'privacy', 'agreement', 'license'],
      agreeKeywords: config.agreeKeywords || ['同意', '接受'],
    });
    if (!sel) return null;
    const loc = page.locator(sel);
    return (await loc.count().catch(() => 0)) > 0 ? loc : null;
  }

  // 常规弹窗 → 整页同意书，两路都找
  async function findConsent() {
    return (await findVisibleModal()) || (await findConsentOverlay());
  }

  // 把协议容器及其所有可滚动子容器滚到底（触发"阅读完才能勾选/解锁"逻辑）
  async function scrollModalToBottom(modal) {
    await modal.evaluate((root) => {
      const go = (el) => {
        try {
          if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight;
        } catch { /* 非滚动元素跳过 */ }
      };
      go(root);
      for (const el of root.querySelectorAll('*')) go(el);
    }).catch(() => {});
  }

  async function checkCheckboxes(modal) {
    for (const sel of config.modalCheckboxSelectors) {
      const loc = modal.locator(sel);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const cb = loc.nth(i);
        if (!(await cb.isVisible().catch(() => false))) continue;
        if (await cb.isChecked().catch(() => false)) continue;
        if (await cb.isDisabled().catch(() => false)) {
          await scrollModalToBottom(modal);
          await page.waitForTimeout(200); // 给"已阅读"解锁一点时间
        }
        try {
          await cb.check({ force: true });
          log('  [协议] 已勾选复选框');
        } catch {
          try {
            await cb.click({ force: true });
            log('  [协议] 已点击复选框');
          } catch (e) {
            log(`  [协议] 勾选失败: ${String(e.message || e).slice(0, 60)}`);
          }
        }
      }
    }
  }

  // 自定义"我已阅读"开关（非 input 复选框）→ 点击解锁同意按钮。
  // 关键：绝不点 label / 含 input 的元素 —— 点 label 会把已勾选的复选框反向切换掉，
  //      导致"同意"按钮重新变禁用（demo 里踩过这个坑）。只点纯自定义控件。
  async function clickReadConfirm(modal) {
    const struct = await modal.evaluate((root) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const structOf = (el) => {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
          const tag = cur.tagName.toLowerCase();
          let idx = 1;
          for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
            if (sib.tagName.toLowerCase() === tag) idx++;
          }
          parts.unshift(`${tag}:nth-of-type(${idx})`);
          cur = cur.parentElement;
        }
        return ['html', ...parts].join(' > ');
      };
      const cands = [];
      for (const el of root.querySelectorAll('[class*="checkbox"], [class*="Checkbox"], [class*="agree"], [class*="Agree"], span, p, div, a')) {
        if (el.tagName.toLowerCase() === 'label') continue; // label 会切换复选框
        if (el.querySelector('input, button')) continue;    // 含输入框/按钮的是容器，不是开关本身
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const text = clean(el.innerText || '');
        const hasRead = /我已阅读|已阅读并同意|我已知晓|已阅读|同意/.test(text);
        const hasCls = /checkbox|agree|read/i.test(el.className);
        if (!hasRead && !hasCls) continue;
        cands.push(el);
      }
      if (!cands.length) return null;
      // 取文本最短的（最贴近真正的开关文字，避免命中大容器）
      cands.sort((a, b) => clean(a.innerText || '').length - clean(b.innerText || '').length);
      return structOf(cands[0]);
    });
    if (!struct) return false;
    try {
      await page.locator(struct).click({ force: true, timeout: 3000 });
      log('  [协议] 点击"我已阅读"文字确认');
      return true;
    } catch { return false; }
  }

  // 等"同意"类按钮从禁用变为可用（滚动到底+勾选后才解锁），再点击
  async function clickAgree(modal) {
    for (const kw of config.agreeKeywords) {
      const btn = modal.locator(
        `button:has-text("${kw}"), [role="button"]:has-text("${kw}"), a:has-text("${kw}"), input[type="submit"][value*="${kw}"]`
      ).last();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      for (let i = 0; i < 12; i++) {
        if (!(await btn.isDisabled().catch(() => false))) break; // 已可用
        await page.waitForTimeout(250);
      }
      if (await btn.isDisabled().catch(() => false)) continue; // 仍禁用 → 试下一个关键词
      try {
        await btn.click({ force: true });
        log(`  [协议] 点击 "${kw}"`);
        return true;
      } catch { /* 试下一个关键词 */ }
    }
    return false;
  }

  async function closeModal(modal) {
    for (const sel of config.modalCloseSelectors) {
      const loc = modal.locator(sel);
      if ((await loc.count().catch(() => 0)) > 0) {
        try { await loc.first().click({ force: true }); return true; } catch { /* 试下一个 */ }
      }
    }
    try { await page.keyboard.press('Escape'); return true; } catch { return false; }
  }

  // 授权类弹窗（云安全中心/云防火墙等"服务角色授权/前往授权/获取授权"）：只点"跳过/暂不/取消"安全关闭，
  // 绝不点"前往授权/同意授权"——触发 IAM 服务角色创建属于副作用动作，与支付同级的必坑项。
  // 记录授权角色名/弹窗文本 → 用户可据此手动操作（授权的节点 route 留人工处理）。
  async function dismissAuthModal(modal) {
    const text = await modal.innerText().catch(() => '');
    if (!/(授权|服务角色|关联策略|permission|grant)/i.test(text)) return false;
    for (const kw of ['跳过', '暂不授权', '暂不', '取消', '下次再说', 'skip', 'cancel', 'later']) {
      const btn = modal.locator(`button:has-text("${kw}"), [role="button"]:has-text("${kw}"), a:has-text("${kw}")`).last();
      if ((await btn.count().catch(() => 0)) > 0) {
        try {
          await btn.click({ force: true });
          const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
          log(`  [授权弹窗] 授权请求「${snippet}」→ 已点"${kw}"，不授权（留待手动操作）`);
          return true;
        } catch { /* 试下一个关键词 */ }
      }
    }
    return false;
  }

  async function handle() {
    await page.waitForTimeout(200);
    for (let attempt = 0; attempt < 3; attempt++) {
      // 授权类弹窗优先处理：点"跳过"关闭，避免走同意流程误点"同意授权"
      const visible = await findVisibleModal();
      if (visible && (await dismissAuthModal(visible))) {
        await page.waitForTimeout(300);
        continue;
      }
      const modal = await findConsent();
      if (!modal) return;
      log(`  [同意书] 检测到协议层 (${attempt + 1}/3)，处理中…`);
      await scrollModalToBottom(modal);
      await page.waitForTimeout(250); // 让"滚到底→解锁勾选→解锁同意按钮"的联动生效
      await checkCheckboxes(modal);
      await clickReadConfirm(modal);
      const clicked = await clickAgree(modal);
      await page.waitForTimeout(400);
      if (!(await findConsent())) {
        if (clicked) log('  [同意书] 已自动同意');
        return;
      }
      await closeModal(modal);
      await page.waitForTimeout(300);
      if (!(await findConsent())) return;
    }
    log('  [同意书] 3 次尝试后仍有关不掉的协议层，按 Esc 兜底');
    await page.keyboard.press('Escape').catch(() => {});
  }

  // SPA 定时轮询时 networkidle 永不触发 → 用"无在途请求持续 quietMs"判稳，超时兜底
  // short=true 用于路径重放途中（只要页面能点下一个元素即可），大幅提速
  async function stabilize(short = false) {
    const s = short
      ? { quietMs: 300, timeoutMs: 5000, settleMs: 200 }
      : config.stabilize;
    const deadline = Date.now() + s.timeoutMs;
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastActivity >= s.quietMs) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, s.settleMs));
  }

  return { handle, stabilize, findVisibleModal };
}
