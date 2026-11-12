import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { compareAgentQuality, createAgentBlindReview, summarizeAgentQuality, type HumanReview, type QualityReport } from './agent-quality.js';

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert(option('--report'), 'Usage: --report report.json [--out directory] [--human-review review.json] [--baseline report.json]');
const path = resolve(option('--report')!);
const source = readFileSync(path, 'utf8');
const report = JSON.parse(source) as QualityReport;
const out = resolve(option('--out') ?? resolve(dirname(path), 'quality'));
mkdirSync(out, { recursive: true });
const templatePath = resolve(out, 'human-review.json');
const template = createAgentBlindReview(report);
if (existsSync(templatePath)) {
  const previous = JSON.parse(readFileSync(templatePath, 'utf8')) as HumanReview[];
  assert.equal(previous.length, template.length, 'Existing review template uses a different case set; choose another output directory');
  const identities = new Map(template.map((row) => [row.case_id, row.case_sha256]));
  assert(previous.every((row) => identities.get(row.case_id) === row.case_sha256), 'Existing review template is stale; choose another output directory');
  summarizeAgentQuality(report, previous);
} else writeFileSync(templatePath, JSON.stringify(template, null, 2));
const reviews = option('--human-review') ? JSON.parse(readFileSync(resolve(option('--human-review')!), 'utf8')) as HumanReview[] : [];
const summary = { ...summarizeAgentQuality(report, reviews), source_report_sha256: createHash('sha256').update(source).digest('hex'),
  comparison: option('--baseline') ? compareAgentQuality(report, JSON.parse(readFileSync(resolve(option('--baseline')!), 'utf8'))) : undefined };
writeFileSync(resolve(out, 'quality.json'), JSON.stringify(summary, null, 2));
writeFileSync(resolve(out, 'summary.md'), [
  '# Agent 业务质量与人工校准', '',
  `运行模式为 ${summary.mode}，题集版本为 ${summary.dataset_hash}。`, '',
  `规则通过 ${summary.summary.rule_passed}/${summary.summary.total}，语义有效判分 ${summary.summary.semantic_checked} 项，判分错误 ${summary.summary.semantic_errors} 项。`,
  `语义通过率为 ${summary.summary.semantic_pass_rate ?? '无有效判分'}，实际输出的语义判分覆盖率为 ${summary.summary.semantic_coverage ?? '不适用'}。`, '',
  `人工校准状态为 ${summary.calibration.status}，已填写 ${summary.calibration.reviewed} 项，可比较 ${summary.calibration.comparable} 项。`,
  `一致率为 ${summary.calibration.agreement_rate ?? '待人工复核'}，误放行 ${summary.calibration.false_pass} 项，误拒绝 ${summary.calibration.false_fail} 项。`, '',
  '人工填写 human-review.json 的 human_verdict、reviewer 和 notes 后，使用 --human-review 重新运行。模板不含自动判定，已有填写内容不会被覆盖。',
  '受控模式验证规则与运行行为，真实质量结论依赖真实产物、有效语义判分及人工校准。', '',
].join('\n'));
console.log(JSON.stringify({ output: out, summary: summary.summary, calibration: summary.calibration }));
