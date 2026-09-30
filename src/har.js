// 从 traffic.jsonl 生成 Burp 可导入的 HAR（去重日志是唯一数据源，HAR 只是格式导出）
// 文本 body 存 text，二进制 body 存 base64（HAR 标准 encoding:base64），Burp/Chrome DevTools 可直接打开。

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

// 解析 URL 的 query 参数为 HAR queryString 数组（Burp 里可读）。对非法 URL 做手动降级解析。
function parseQueryString(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    const i = url.indexOf('?');
    if (i < 0) return [];
    return url.slice(i + 1).split('&').filter(Boolean).map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0 ? { name: pair, value: '' } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  }
}

export function buildHarFromTraffic(trafficFile, harFile, { removeJsonl = false } = {}) {
  if (!existsSync(trafficFile)) return 0;
  const lines = readFileSync(trafficFile, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map((l) => {
    const e = JSON.parse(l);
    const headers = (h = {}) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
    const request = {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: headers(e.reqHeaders),
      queryString: parseQueryString(e.url),
      headersSize: -1,
      bodySize: (e.postData || '').length,
    };
    if (e.postData) {
      request.postData = {
        mimeType: (e.reqHeaders && e.reqHeaders['content-type']) || 'application/x-www-form-urlencoded',
        text: e.postData,
      };
    }
    const content = { size: e.respBytes || 0, mimeType: e.contentType || '' };
    if (e.body !== undefined && !e.bodyOmitted) {
      if (e.bodyEncoding === 'base64') { content.text = e.body; content.encoding = 'base64'; }
      else content.text = e.body;
    }
    return {
      startedDateTime: e.ts ? new Date(e.ts).toISOString() : new Date(0).toISOString(),
      time: 0,
      request,
      response: {
        status: e.status || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: headers(e.respHeaders),
        content,
        redirectURL: '',
        headersSize: -1,
        bodySize: e.respBytes || 0,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  });
  const har = { log: { version: '1.2', creator: { name: 'bfs-clicker', version: '1.0' }, entries } };
  writeFileSync(harFile, JSON.stringify(har));
  if (removeJsonl) unlinkSync(trafficFile);
  return entries.length;
}
