// 统计 HAR: 总请求 / 同host / 去重唯一请求 / 按类型分布
const fs = require('fs');

const harPath = process.argv[2] || 'output/traffic.har';
const targetHost = process.argv[3] || 'console.volcengine.com';
// 域族口径: host === target 或以 "." + 主域 结尾。第三个参数传主域(如 volcengine.com)时自动启用域族匹配
const domainFamily = targetHost.split('.').slice(-2).join('.');
const inScope = (h) => h === targetHost || h.endsWith('.' + domainFamily) || h.endsWith('.' + targetHost);

const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har.log.entries || [];

const STATIC_EXT = /\.(gif|jpe?g|png|ico|css|woff2?|ttf|svg|m?js|map)(\?|$)/i;

let total = 0;
let sameHost = 0;
const uniqAll = new Set();      // method + url(去query)
const uniqApi = new Set();      // 仅 xhr/fetch 或 非静态扩展
const byType = {};
const hostDist = {};

for (const e of entries) {
  total++;
  const url = e.request.url;
  let u;
  try { u = new URL(url); } catch { continue; }
  const host = u.host;
  hostDist[host] = (hostDist[host] || 0) + 1;

  // resource type 推断: HAR 里 _resourceType 或 response content
  const rt = (e._resourceType || '').toLowerCase();
  byType[rt || 'unknown'] = (byType[rt || 'unknown'] || 0) + 1;

  if (!inScope(host)) continue;
  sameHost++;

  const norm = `${e.request.method} ${u.origin}${u.pathname}`;
  uniqAll.add(norm);

  const isStatic = STATIC_EXT.test(u.pathname);
  const isApi = rt === 'xhr' || rt === 'fetch' || (!isStatic && rt !== 'document' && rt !== 'stylesheet' && rt !== 'script' && rt !== 'image' && rt !== 'font' && rt !== 'media');
  if (isApi) uniqApi.add(norm);
  if (isStatic) uniqAll.delete(norm); // 静态资源不计入"触发请求"口径
}

console.log(JSON.stringify({
  har: harPath,
  targetHost,
  total_requests: total,
  same_host_requests: sameHost,
  unique_method_path_same_host: uniqAll.size,
  unique_api_like_same_host: uniqApi.size,
  by_resource_type: byType,
  top_hosts: Object.fromEntries(Object.entries(hostDist).sort((a, b) => b[1] - a[1]).slice(0, 15)),
}, null, 2));
