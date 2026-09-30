// 流量去重记录器（Playwright 原生捕获，无需 Burp/代理）
// 去重键 = method + 归一化URL + 响应大小 + status + POST body 指纹
//   - 归一化URL：剥掉 noise 参数（t/_/random/sessionId/reqSeqId 等时间戳与随机数），
//     query 参数排序 → 同一接口（带 ?t= 时间戳）的每次调用不再被当成不同条目
//   - 响应大小：有 Content-Length 头 → 用它做快速去重（命中则不读 body，省内存）
//     无 Content-Length（chunked）→ 读 body 用实际字节数作为大小键
//   - status 进键：同 URL 同大小但状态不同（200/401/403）不会误合并
//   - POST body 指纹：同 URL 同大小但 POST body 不同（不同 Action 参数）不会被误合并
// 记录范围 = 爬虫看到的全部响应（含静态资源，同样去重），可选 include/exclude/excludeHost 过滤。
// 每条存完整请求/响应包：请求头、postData、响应头、响应体（文本 utf8 / 二进制 base64，超上限截断）。
// 输出 output/traffic.jsonl（每行一条 JSON，追加写，内存只留去重键 → 长时间跑不爆内存）。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 默认噪声参数：时间戳/随机数/会话ID/遥测字段等。全部小写，匹配时忽略大小写。
// 若某项被误伤（如 token 想在键里保留），可用 trafficKeepQueryParams 白名单覆盖。
const DEFAULT_STRIP_PARAMS = [
  't', '_', '_t', '_dc', 'random', 'rand', 'rnd', 'nonce', 'timestamp', 'ts',
  'sessionid', 'reqseqid', 'seqid', 'seq', 'expvalue', 'expkey', 'fst', 'contextkey',
  'guid', 'callback', 'traceid', 'requestid', 'uuid',
  'visitid', 'landingpage', 'pagetitle', '_ga', 'fromsource', 'lastlogintype',
  'ul', 'vp', 'sr', 'nettype', '_pn', 'lifeid', 'originfrom', 'tag_exp', 'rcb', 'tiba',
  'dnslookup', 'tcp', 'ssl', 'ttfb', 'contentdownload', 'domparse', 'resourcedownload', 'firstscreentiming',
  'aid', 'gtm', 'ext1', 'e', 'mc_gtk', 'attaid',
  'u_w', 'u_h', 'uab', 'uafvl', 'uamb', 'uap', 'uapv', 'uaw', 'uaa',
];

// 归一化 URL：剥掉噪声参数、排序剩余参数，得到稳定的去重 URL。
// - stripParams: 剥掉的参数名（小写集合）；keepParams: 白名单，命中则即使在被剥列表也保留
export function trafficNormalizeQuery(url, { stripParams = DEFAULT_STRIP_PARAMS, keepParams = [] } = {}) {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const strip = new Set((stripParams || []).map((s) => String(s).toLowerCase()));
  const keep = new Set((keepParams || []).map((s) => String(s).toLowerCase()));
  const kept = [];
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const kl = k.toLowerCase();
    if (!keep.has(kl) && strip.has(kl)) continue;
    kept.push(pair);
  }
  if (!kept.length) return base;
  kept.sort();
  return `${base}?${kept.join('&')}`;
}

export function makeTraffic(config, log) {
  const seen = new Set();
  const file = path.join(config.outputDir, 'traffic.jsonl');
  const maxBody = config.trafficMaxBodyBytes ?? 65536;
  const includeRe = (config.trafficIncludePattern || []).map((p) => new RegExp(p));
  const excludeRe = (config.trafficExcludeExt || []).map((p) => new RegExp(`\\.${p}(\\?|$)`, 'i'));
  const excludeHostRe = (config.trafficExcludeHost || []).map((p) => new RegExp(p));
  const stripParams = config.trafficStripQueryParams ?? DEFAULT_STRIP_PARAMS;
  const keepParams = config.trafficKeepQueryParams || [];

  // 默认全记录；配置了 include 则只记录匹配 host，excludeExt 跳过对应扩展名，excludeHost 跳过对应域名
  function shouldCapture(url) {
    if (includeRe.length && !includeRe.some((re) => re.test(url))) return false;
    if (excludeRe.some((re) => re.test(url))) return false;
    if (excludeHostRe.length) {
      try {
        const host = new URL(url).host;
        if (excludeHostRe.some((re) => re.test(host))) return false;
      } catch { /* 无效 URL → 不按 host 排除 */ }
    }
    return true;
  }

  const isText = (ct = '') =>
    /text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|application\/.*\+json/i.test(ct);

  // 请求体指纹：两个不同种子的 32 位 FNV-1a 组合 ≈ 64 位，防同 URL 同大小但 body 不同被误合并
  function hashPostData(s) {
    if (!s) return '';
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193);
      h2 = Math.imul(h2 ^ str.charCodeAt(i), 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  }

  async function onResponse(resp) {
    try {
      const req = resp.request();
      const url = req.url();
      if (!shouldCapture(url)) return;
      const method = req.method();
      const headers = resp.headers();
      const cl = /^\d+$/.test(headers['content-length'] || '') ? parseInt(headers['content-length'], 10) : null;
      const status = resp.status();
      const normUrl = trafficNormalizeQuery(url, { stripParams, keepParams });
      const postData = safe(() => req.postData());
      const bh = hashPostData(postData);

      // 快速去重：同 归一化URL + Content-Length + status + body指纹 → 判定为同一响应，跳过（不读 body）
      if (cl !== null && seen.has(`${method}|${normUrl}|${cl}|${status}|${bh}`)) return;

      // 读 body 的时机：无 CL（要拿实际大小）或 CL ≤ 上限（要存完整包）。
      // CL 存在且超过上限 → 不读（大小已由 CL 给出，只存元数据，避免拉大下载）。
      let buf = null;
      if (cl === null || cl <= maxBody) {
        try { buf = await resp.body(); } catch { /* 读取失败（中断/已消费）→ 只存元数据 */ }
      }
      const actualSize = buf ? buf.length : cl;
      if (actualSize === null) return; // 既无 CL 也读不到 body，无法确定大小 → 跳过
      const key = `${method}|${normUrl}|${actualSize}|${status}|${bh}`;
      if (seen.has(key)) return;       // 无 CL 场景：按实际大小去重

      const text = isText(headers['content-type']);
      let body;
      let bodyTruncated = false;
      if (buf) {
        bodyTruncated = buf.length > maxBody;
        const part = buf.slice(0, maxBody);
        body = text ? part.toString('utf8') : part.toString('base64');
      }
      const entry = {
        ts: Date.now(),
        method,
        url,                             // 保留原始 URL（HAR/人工分析用原始参数）
        normUrl,                         // 去重用的归一化 URL（便于核对去重逻辑）
        status,
        contentType: headers['content-type'] || null,
        contentLength: cl,               // 原始 Content-Length（无则为 null）
        respBytes: actualSize,           // 去重用的大小键
        reqHeaders: req.headers(),
        postData,
        respHeaders: headers,
        body,
        bodyEncoding: buf ? (text ? 'utf8' : 'base64') : undefined,
        bodyTruncated,
        bodyOmitted: !buf,               // 读不到 body（超大/中断）→ 只存元数据
      };
      appendFileSync(file, JSON.stringify(entry) + '\n');
      seen.add(key);
    } catch (e) {
      log && log(`  [traffic] 记录失败: ${String(e.message || e).slice(0, 80)}`);
    }
  }

  function safe(fn) {
    try { return fn(); } catch { return null; }
  }

  return {
    attach(ctx) { ctx.on('response', onResponse); },
    get stats() { return { entries: seen.size, file }; },
  };
}

export function ensureTrafficDir(config) {
  mkdirSync(config.outputDir, { recursive: true });
}
