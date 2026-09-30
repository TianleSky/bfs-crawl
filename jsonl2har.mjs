// 手动把 traffic.jsonl 转成 HAR（assist 被强杀等没来得及自动转的场景兜底）
// 用法: node jsonl2har.mjs [traffic.jsonl 路径] [输出 har 路径]
import { buildHarFromTraffic } from './src/har.js';

const input = process.argv[2] || 'output-assist/traffic.jsonl';
const output = process.argv[3] || input.replace(/\.jsonl$/i, '') + '.har';
const n = buildHarFromTraffic(input, output, { removeJsonl: false });
console.log(`${n} 条 → ${output}`);
