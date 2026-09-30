// 冒烟测试：三大件改造验证（iframe 全遍历 / 语义危险门禁 / 滚动懒加载）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { collectInteractives, isDangerous } from './src/discover.js';

const FRAME_HTML = `<!doctype html><html><body>
<button>iframe内查询按钮</button>
<a href="/frame-inner">iframe内链接</a>
</body></html>`;

const MAIN_HTML = `<!doctype html><html><body>
<h1>冒烟主页</h1>
<button id="q">查询</button>
<a href="/reset-password">重置密码</a>
<a href="/user/delete?id=1">删除账户</a>
<button>删除数据</button>
<iframe src="/frame.html" style="width:400px;height:200px"></iframe>
<div style="height:2500px">占位：撑出滚动条</div>
<div id="list"></div>
<script>
let n = 0;
window.addEventListener('scroll', () => {
  const se = document.scrollingElement;
  if (se.scrollTop + innerHeight >= se.scrollHeight - 50 && n < 30) {
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('button');
      b.textContent = '懒加载按钮' + (++n);
      document.getElementById('list').appendChild(b);
    }
  }
});
</script>
</body></html>`;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(req.url === '/frame.html' ? FRAME_HTML : MAIN_HTML);
});
await new Promise((r) => server.listen(18923, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto('http://127.0.0.1:18923/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

const config = {
  startUrl: 'http://127.0.0.1:18923/',
  includeUrlPattern: '127\\.0\\.0\\.1:18923',
  skipTextPatterns: ['删除', '重置', '支付'],
  fillText: false,
};

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${actual} (期望 ${expected})`);
  ok ? pass++ : fail++;
};

// 1) iframe 全遍历
const items = await collectInteractives(page, config);
const iframeItems = items.filter((i) => i.frameUrl);
const iframeBtn = items.find((i) => i.text === 'iframe内查询按钮');
console.log(`采集总数: ${items.length}, iframe 元素数: ${iframeItems.length}`);
check('iframe 内按钮采到', !!iframeBtn, true);
check('iframe 元素带 frameUrl', iframeBtn ? iframeBtn.frameUrl.includes('frame.html') : false, true);

// 2) 语义危险门禁
const navReset = items.find((i) => i.text === '重置密码');
const delLink = items.find((i) => i.text === '删除账户');
const delBtn = items.find((i) => i.text === '删除数据');
check('重置密码(危险词+安全href)放行', navReset && navReset.skipped, false);
check('删除账户(危险词+危险href)拦截', delLink && delLink.skipped, true);
check('删除数据(危险词+无href)拦截', delBtn && delBtn.skipped, true);
check('isDangerous 无危险词', isDangerous({ text: '查询', href: '' }, config), false);
check('isDangerous 外链危险词不豁免', isDangerous({ text: '删除', href: 'http://evil.com/delete' }, config), true);

// 3) 滚动懒加载：滚动后 collectInteractives 能采到新按钮
const beforeCount = items.length;
await page.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
await page.waitForTimeout(1200);
const afterItems = await collectInteractives(page, config);
const lazyBtn = afterItems.find((i) => (i.text || '').startsWith('懒加载按钮'));
console.log(`滚动前后采集数: ${beforeCount} -> ${afterItems.length}`);
check('懒加载按钮采到', !!lazyBtn, true);

await browser.close();
server.close();
console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
