// 临时验证脚本：加载 session.json 无头打开站点，确认是否真的处于登录态
import { chromium } from 'playwright';

const b = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  ignoreHTTPSErrors: true,
  storageState: 'output/session.json',
});
const page = await ctx.newPage();
await page.goto('https://buyin.jinritemai.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());
const cookies = await ctx.cookies();
console.log('COOKIES:', cookies.map((c) => c.name).join(', '));
await b.close();
