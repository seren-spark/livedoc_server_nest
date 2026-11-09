// Real coverage-model regression using only fixed synthetic text. No database or API writes.
import { writeFile } from "node:fs/promises";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
import { WikiService } from "../src/wiki/wiki.service.js";
import type { WikiCoverage, WikiEvidence } from "../src/wiki/wiki.types.js";

const config = new AppConfig();
const wiki = new WikiService(config, undefined as any, undefined as any, undefined as any,
  undefined as any, new LlmService(config));
const recall = "本虚构样例中，向量召回查找语义相近表达，关键词匹配补充术语、编号和精确词项，两路相互补充。";
const fusion = "本虚构样例中，每路先取20个候选，用RRF按排名融合，分数为各路1/(60+rank)之和，rank从1开始。融合后按chunk_id去重，交给重排模型排序，最终取前5条。RRF不直接相加原始分数。";
const page = (markdown: string, index: number): WikiEvidence => ({ proof: { wiki_id: `synthetic_${index}`, revision: 1 },
  title: "虚构混合检索样例", markdown, citations: [] });
const cases: Array<{ name: string; question: string; query: string; pages: string[]; expected: WikiCoverage[] }> = [
  { name: "paraphrase", question: "语义召回与精确词项匹配怎样配合？", query: "向量关键词互补",
    pages: [recall + fusion], expected: ["full"] },
  { name: "subset", question: "只用一句话解释向量和关键词为何互补，不展开融合参数。", query: "混合检索RRF去重重排",
    pages: [recall + fusion], expected: ["full"] },
  { name: "joint_coverage", question: "请解释两路召回如何互补，并说明融合公式、去重和重排后的取数规则。", query: "混合检索流程",
    pages: [recall, fusion], expected: ["full"] },
  { name: "actual_gap", question: "解释向量和关键词如何互补，以及重排得分并列时的顺序。", query: "召回与重排并列",
    pages: [recall, fusion], expected: ["partial"] },
  { name: "unrelated", question: "候选文稿需要什么操作才进入正式正文？", query: "文稿采纳",
    pages: [recall, fusion], expected: ["none"] },
  { name: "conflicting_pages", question: "该样例的RRF融合是相加排名倒数还是直接相加原始分数？", query: "RRF融合",
    pages: [fusion, "同一虚构样例同一配置中，RRF直接相加原始分数，不使用排名。"], expected: ["partial", "none"] },
];
const report: Record<string, any> = { simulated: false, synthetic_only: true, database_access: false,
  checked_at: new Date().toISOString(), model: config.agentCriticModel || config.llmModel, cases: [] };
try {
  for (const item of cases) {
    const usage = { model_requests: 0, prompt_tokens: 0, completion_tokens: 0 };
    const started = Date.now();
    const result = await wiki.coverage(item.question, item.query, item.pages.map(page), AbortSignal.timeout(20000), [usage]);
    const passed = item.expected.includes(result.coverage) && (result.coverage !== "partial" || result.missing.length > 0);
    report.cases.push({ name: item.name, expected: item.expected, ...result, passed, usage, duration_ms: Date.now() - started });
  }
  report.passed = report.cases.every((item: any) => item.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message.slice(0, 300) : "probe failed";
  process.exitCode = 1;
} finally {
  await wiki.onModuleDestroy();
  await writeFile("../docs/wiki-retrieval-coverage-real.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
