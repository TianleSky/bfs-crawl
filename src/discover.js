// 可点击元素发现 + 稳定定位器生成
// 定位器优先级：角色+可访问名（getByRole，重渲染稳定） > 结构路径（html>body>div:nth-of-type(k)>...）
// 结构路径在发现时校验唯一性，用于回放兜底。

export const BASE_SELECTOR = [
  'button',
  'a[href]',
  'input[type="button"], input[type="submit"], input[type="checkbox"], input[type="radio"], input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="number"], textarea',
  'select',
  '[role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="link"]',
  '[onclick]',
  '[contenteditable="true"]',
  'summary',
  '.el-button',
  'label',
].join(', ');

// ---------- 元素类型分类（Node 侧纯函数） ----------

function classify(el, desc) {
  const tag = desc.tag;
  const type = desc.type;
  if (tag === 'select') return 'select';
  if (tag === 'input' || tag === 'textarea') {
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'click';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'text';
  }
  if (desc.role === 'checkbox') return 'checkbox';
  if (desc.role === 'radio') return 'radio';
  if (el && el.getAttribute('contenteditable') === 'true') return 'text';
  return 'click';
}

// ---------- 导出 ----------

export function stepLabel(el) {
  return el.label || el.text || el.href || el.tag || el.selector;
}

// 单 document 内的交互面采集逻辑（主 frame / iframe 通用，evaluate 进各自 frame 上下文执行）
function collectInDocument(sel) {
    const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const isVisible = (el) => {
      // 与 Playwright isVisible 语义一致：非空包围盒 + 非 display:none + 非 visibility:hidden
      // （不过滤 opacity:0 —— 隐藏子菜单/透明覆盖层仍是可点击 DOM 元素，安全测试需要全点）
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
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
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      const text = cleanText(el.innerText || el.textContent || '');
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const href = (el.getAttribute('href') || '').trim();
      const placeholder = el.getAttribute('placeholder') || '';
      const role = el.getAttribute('role') || '';
      const accessibleName = aria || title || text;
      out.push({ tag, type, text, aria, href, placeholder, role, accessibleName, struct: structOf(el) });
    }
    return out;
}

export async function collectInteractives(page, config) {
  // 批量采集：iframe 全遍历——逐 frame evaluate 采集（跨域/已 detach 的 frame 直接跳过），
  // 每元素带 frameUrl（主 frame 记空串）；再按 frame 分组批量校验结构路径唯一性。
  const frames = page.frames();
  const frameUrlOf = (f) => (f === page.mainFrame() ? '' : (f.url() || ''));
  const frameOf = (fu) => frames.find((f) => frameUrlOf(f) === fu) || page;
  const rows = [];
  for (const frame of frames) {
    let frameRows;
    try { frameRows = await frame.evaluate(collectInDocument, BASE_SELECTOR); }
    catch { continue; } // 跨域/已 detach 的 frame 跳过
    const fu = frameUrlOf(frame);
    for (const r of frameRows) { r.frameUrl = fu; rows.push(r); }
  }

  // 按 frame 分组批量校验结构路径唯一性（同 frame 内唯一即可；跨 frame 撞 struct 无所谓，locate 带 frame 上下文）
  const structCounts = {};
  const structsByFrame = new Map();
  for (const r of rows) {
    const list = structsByFrame.get(r.frameUrl) || [];
    list.push(r.struct);
    structsByFrame.set(r.frameUrl, list);
  }
  for (const [fu, structs] of structsByFrame) {
    try {
      const counts = await frameOf(fu).evaluate((ss) => {
        const m = {};
        for (const s of ss) { m[s] = document.querySelectorAll(s).length; }
        return m;
      }, structs);
      for (const s of structs) structCounts[fu + '\n' + s] = counts[s];
    } catch { /* ignore */ }
  }

  const seen = new Set();
  const result = [];
  for (const meta of rows) {
    const dedupeKey = meta.frameUrl + '\n' + meta.struct;
    if (seen.has(dedupeKey)) continue; // 同一元素被多个选择器命中
    seen.add(dedupeKey);

    if (meta.type === 'text' && !config.fillText) continue; // 不填充文本框时直接不点
    if (config.excludeTextPatterns && config.excludeTextPatterns.some((p) => meta.text.includes(p))) continue;

    const structUnique = structCounts[meta.frameUrl + '\n' + meta.struct] === 1;

    // 角色+可访问名定位器（重渲染更稳定）——在元素所在 frame 内校验唯一性
    let selector = meta.struct;
    if (meta.role && meta.accessibleName) {
      try {
        const rl = frameOf(meta.frameUrl).getByRole(meta.role, { name: meta.accessibleName, exact: false });
        if ((await rl.count()) === 1) {
          selector = 'role::' + meta.role + '::' + JSON.stringify(meta.accessibleName);
        }
      } catch { /* 该角色不受支持，退回结构路径 */ }
    }

    // 语义危险门禁：命中危险词但带"真实入范围导航 href"的只读链接放行；无 href 按钮照旧 skipped
    const skipped = isDangerous(meta, config);

    result.push({
      selector,
      fallbackSelector: meta.struct,
      structUnique,
      label: meta.text || meta.placeholder || meta.aria || meta.href || meta.tag,
      href: meta.href,
      role: meta.role,
      tag: meta.tag,
      type: classify(null, meta),
      text: meta.text,
      skipped,
      frameUrl: meta.frameUrl,
    });
  }
  return result;
}

// 元素所在 frame 上下文：frameUrl 匹配当前存活 frame；frame 已重导航/销毁时退回主 document，
// 由 replay.js 的 relocateByLabel 重采交互面兜底（新 frameUrl 随之生效）。
function frameContext(page, el) {
  if (!el.frameUrl) return page;
  return page.frames().find((f) => f !== page.mainFrame() && (f.url() || '') === el.frameUrl) || page;
}

export function locate(page, el) {
  const ctx = frameContext(page, el);
  if (el.selector && el.selector.startsWith('role::')) {
    const parts = el.selector.split('::'); // ['role', role, JSON(name)]
    if (parts.length === 3) {
      try { return ctx.getByRole(parts[1], { name: JSON.parse(parts[2]), exact: false }); } catch { /* fallthrough */ }
    }
  }
  return ctx.locator(el.selector || el.fallbackSelector);
}

// ---------- 语义危险门禁 ----------

// 危险 href 模式：路径段级匹配 GET 写操作链接（/user/reset、/delete?id=1 命中；
// /reset-password 这类"段内子串"不命中——重置密码导航页是只读）
const DANGEROUS_HREF_RE = /(?:^|\/)(?:logout|delete|remove|destroy|terminate|pay|reset|disable|revoke)(?:[\/?.]|$)/i;

// skipTextPatterns 命中后的二次判定（借鉴 jsfinder 只读导航白名单的泛化，无需维护词表）：
// - 无真实导航 href（按钮/#/javascript:）→ 危险，skipped
// - href 真实、入范围、且不命中危险 href 模式 → 只读 GET 导航，放行
export function isDangerous(meta, config) {
  const text = (meta.text || meta.label || '').toLowerCase();
  const hit = (config.skipTextPatterns || []).some((p) => text.includes(String(p).toLowerCase()));
  if (!hit) return false;
  const href = (meta.href || '').trim();
  if (!href || href === '#' || href === '/' || /^javascript:/i.test(href)) return true;
  let url;
  try { url = new URL(href, config.startUrl).href; } catch { return true; }
  if (config.includeUrlPattern && !new RegExp(config.includeUrlPattern).test(url)) return true; // 外链不豁免
  if (DANGEROUS_HREF_RE.test(url)) return true; // GET 写操作链接不豁免
  return false;
}
