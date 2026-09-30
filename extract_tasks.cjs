// 从 checkpoint.json 提取 LLM 补盲任务清单 → assist-tasks.json
// 任务页判定：有 failed 元素（爬虫点不动）或含表单类控件（select/checkbox/radio，即"需要决策的交互"）。
// 清单只回答"哪些页面值得去"，控件细节由 LLM 到现场（MCP snapshot）自己看。
// 用法: node extract_tasks.cjs [checkpoint路径] [输出路径]
const fs = require('fs');

const cpPath = process.argv[2] || 'output/checkpoint.json';
const outPath = process.argv[3] || 'output/assist-tasks.json';

const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
const tasks = [];
for (const s of cp.states || []) {
  const failed = (s.failed || []).map((f) => ({ label: f.label || '', tag: f.tag || '', type: f.type || '' }));
  const formControls = (s.interactives || [])
    .filter((i) => ['select', 'checkbox', 'radio'].includes(i.type))
    .map((i) => ({ label: i.label || '', tag: i.tag || '', type: i.type || '' }));
  if (!failed.length && !formControls.length) continue;
  const reasons = [];
  if (failed.length) reasons.push(`${failed.length} 个元素点不动`);
  if (formControls.length) reasons.push(`${formControls.length} 个表单控件待决策`);
  tasks.push({
    id: s.id,
    url: s.url,
    title: s.title || '',
    depth: s.depth,
    pathLabels: (s.path || []).map((p) => p.label || p.text || p.href || '').filter(Boolean),
    reason: reasons.join('；'),
    failed,
    formControls,
  });
}
fs.writeFileSync(outPath, JSON.stringify(tasks, null, 2));
console.log(`提取 ${tasks.length} 个补盲任务页 → ${outPath}`);
for (const t of tasks.slice(0, 20)) {
  console.log(`  #${t.id} [${t.reason}] ${t.title || t.url}`);
}
if (tasks.length > 20) console.log(`  ... 其余 ${tasks.length - 20} 个见 json`);
