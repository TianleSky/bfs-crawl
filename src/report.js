// 输出 output/tree.json（嵌套状态树）+ output/overview.html（节点全览图）
// 全览图：可折叠状态树 + 每个状态的截图/路径/可点控件（跳过、失败标记）+ 重复路径表

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stepLabel } from './discover.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const failedSelOf = (st) => new Set((st.failed || []).map((f) => f.selector));

export function writeReport({ allStates, visitedHits, config, elapsedMs, log, backEdges = [] }) {
  const node = (id) => {
    const st = allStates.get(id);
    if (!st) return null;
    const failed = failedSelOf(st);
    return {
      id: st.id,
      depth: st.depth,
      url: st.url,
      title: st.title,
      pathLabels: (st.path || []).map(stepLabel),
      clickables: (st.interactives || []).map((el) => ({
        label: el.label, type: el.type, href: el.href, selector: el.selector,
        skipped: !!el.skipped,   // 付款类等跳过控件，供人工处理
        failed: failed.has(el.selector), // 前置缺失/点击失败，待人工
      })),
      children: (st.children || []).map((c) => node(c)).filter(Boolean),
    };
  };

  const report = {
    generatedAt: new Date().toISOString(),
    startUrl: config.startUrl,
    elapsedMs,
    totalStates: allStates.size,
    visitedHits,
    maxDepth: config.maxDepth,
    backEdges, // 重复路径（回到任何已访问节点 = 走错的路）
    tree: node(1),
  };

  const out = path.join(config.outputDir, 'tree.json');
  mkdirSync(config.outputDir, { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeOverview(report, config.outputDir);
  log(`\n[报告] ${out}`);
  log(`[报告] 总状态数 ${allStates.size} | visited 去重命中 ${visitedHits} | 重复路径 ${backEdges.length} | 耗时 ${(elapsedMs / 1000).toFixed(1)}s`);
  log(`[全览图] ${path.join(config.outputDir, 'overview.html')}`);
}

function writeOverview({ totalStates, visitedHits, maxDepth, elapsedMs, backEdges, startUrl, tree }, outputDir) {
  // tree 已是树形结构（从 report 传入），直接渲染
  const renderState = (st, open) => {
    if (!st) return '';
    const skipCount = st.clickables.filter((c) => c.skipped).length;
    const failCount = st.clickables.filter((c) => c.failed).length;
    const badges = [
      skipCount ? `<span class="b b-skip">跳过 ${skipCount}</span>` : '',
      failCount ? `<span class="b b-fail">前置缺失 ${failCount}</span>` : '',
    ].filter(Boolean).join(' ');
    const children = (st.children || []).map((c) => renderState(c, st.depth < 1)).join('');
    const rows = (st.clickables || []).map((c) => {
      const status = c.skipped ? '<span class="st-skip">跳过</span>'
        : c.failed ? '<span class="st-fail">失败</span>'
        : '<span class="st-ok">已点</span>';
      return `<tr><td class="lbl">${esc(c.label || c.href || c.selector)}</td><td>${esc(c.type || 'click')}</td><td>${status}</td></tr>`;
    }).join('');
    const shot = `states/${String(st.id).padStart(3, '0')}.png`;
    return `<li>
      <details ${open ? 'open' : ''}>
        <summary><b>#${st.id}</b> <span class="d">d${st.depth}</span> ${esc(st.title || st.url)}
          <span class="url">${esc(st.url)}</span> ${badges}</summary>
        <div class="body">
          <div class="crumbs">路径: ${(st.pathLabels || []).join(' › ') || '（根）'}</div>
          ${children ? `<details ${st.depth < 1 ? 'open' : ''}><summary>子节点 ${st.children.length}</summary><ul>${children}</ul></details>` : ''}
          ${rows ? `<details><summary>可点控件 ${st.clickables.length}（已点/跳过/失败）</summary><table><tr><th>控件</th><th>类型</th><th>状态</th></tr>${rows}</table></details>` : ''}
          <div class="shot"><a href="${shot}" target="_blank"><img src="${shot}" alt="#${st.id}" loading="lazy"></a></div>
        </div>
      </details>
    </li>`;
  };

  const edgeRows = (backEdges || []).map((e) => {
    const kind = e.kind === 'expansion'
      ? '<span class="b b-exp">展开</span>'
      : '<span class="b b-dup">重复</span>';
    return `<tr><td>#${e.from}</td><td>${esc(e.label)}</td><td>→ #${e.to}</td><td>${kind}</td><td class="url">${esc(e.url)}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>节点全览图 · ${esc(startUrl)}</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:24px;background:#0f172a;color:#e2e8f0;font-size:14px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:22px 0 8px}
  .stats{color:#94a3b8;margin-bottom:16px;font-size:13px}
  .b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;margin-left:6px;vertical-align:1px}
  .b-skip{background:#7c2d12;color:#fdba74}.b-fail{background:#7f1d1d;color:#fecaca}
  .b-dup{background:#1e293b;color:#94a3b8}.b-exp{background:#14532d;color:#86efac}
  ul{list-style:none;padding-left:18px} .tree>ul{padding-left:0}
  details>summary{cursor:pointer;padding:3px 4px;border-radius:4px}
  details>summary:hover{background:#1e293b}
  .d{color:#38bdf8}.url{color:#64748b;font-size:12px;margin-left:8px;word-break:break-all}
  .body{padding:6px 0 10px 16px}.crumbs{color:#94a3b8;margin-bottom:6px;font-size:13px}
  table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid #334155;padding:2px 8px;text-align:left;font-size:12px}
  th{background:#1e293b}.lbl{max-width:420px;word-break:break-all}
  .st-ok{color:#4ade80}.st-skip{color:#fb923c}.st-fail{color:#f87171}
  .shot img{max-width:240px;border:1px solid #334155;border-radius:6px;margin:6px 0;display:block}
</style></head><body>
<h1>节点全览图</h1>
<div class="stats">入口 ${esc(startUrl)} · ${totalStates} 个状态 · visited 命中 ${visitedHits} · maxDepth ${maxDepth} · 耗时 ${(elapsedMs / 1000).toFixed(1)}s · ${new Date().toISOString()}</div>
<div><span class="b b-skip">跳过（付款类，人工处理）</span><span class="b b-fail">前置缺失（点击失败，待人工）</span></div>
<h2>重复路径（子节点回到任何已访问节点 = 这条路走错了）${backEdges.length ? ` · ${backEdges.length} 条` : ' · 无'}</h2>
${backEdges.length
  ? `<table><tr><th>来源状态</th><th>点击的控件</th><th>命中已访问</th><th>类型</th><th>URL</th></tr>${edgeRows}</table>`
  : '<p class="url">本轮暂无重复命中（或尚未发生）。</p>'}
<h2>状态树</h2>
<div class="tree"><ul>${renderState(tree, true)}</ul></div>
</body></html>`;

  const out = path.join(outputDir, 'overview.html');
  writeFileSync(out, html);
}
