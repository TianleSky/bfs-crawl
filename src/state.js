import { createHash } from 'node:crypto';
import { BASE_SELECTOR } from './discover.js';

export function md5(s) {
  return createHash('md5').update(String(s)).digest('hex');
}

/**
 * 状态指纹 = md5( 规范化 URL + 页面标题 + 交互面描述列表 )
 * 交互面 = 页面上每个可见可交互元素的 {tag|text|href|role|aria|type|placeholder}，
 * 排序后 + 可见标题。
 * 语义：'能点什么'这套没变 → 视为同一状态。定时器的动态数字/请求ID不影响指纹，
 * 避免 SPA 每次轮询都被当成新页面导致状态爆炸。
 */
export async function fingerprint(page) {
  const info = await page.evaluate((selector) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const isVisible = (el) => {
      // 与 discover.js 一致：不过滤 opacity:0（隐藏菜单/覆盖层仍是可点 DOM 元素）
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const lines = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const text = clean(el.innerText || el.textContent || '');
      const href = (el.getAttribute('href') || '').trim();
      const role = el.getAttribute('role') || '';
      const aria = el.getAttribute('aria-label') || '';
      const type = (el.type || '').toLowerCase();
      const ph = el.getAttribute('placeholder') || '';
      lines.push([tag, text, href, role, aria, type, ph].join('|'));
    }
    lines.sort();
    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter(isVisible)
      .map((h) => h.tagName.toLowerCase() + ':' + clean(h.innerText))
      .sort();
    return { href: location.href, title: document.title, lines, headings };
  }, BASE_SELECTOR);

  const payload = JSON.stringify([info.href, info.title, info.lines, info.headings]);
  return { fp: md5(payload), url: info.href, title: info.title };
}
