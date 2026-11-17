/**
 * @file Worker 交接。约束子任务的发现、缺口、冲突和证据交付格式。
 */
import { Ajv } from "ajv";
import { BadRequestException } from "@nestjs/common";

export interface WorkerHandoff {
  coverage: "complete" | "partial" | "insufficient" | "conflicted";
  findings: Array<{ statement: string; evidence_ids: string[] }>;
  missing: string[];
  conflicts: Array<{ description: string; evidence_ids: string[] }>;
}

const evidenceIds = { type: "array", minItems: 1, maxItems: 10, uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 160 } };
export const workerHandoffSchema = {
  type: "object", additionalProperties: false,
  properties: {
    findings: { type: "array", maxItems: 6, items: {
      type: "object", additionalProperties: false,
      properties: { statement: { type: "string", minLength: 1, maxLength: 500 }, evidence_ids: evidenceIds },
      required: ["statement", "evidence_ids"],
    } },
    missing: { type: "array", maxItems: 6, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 300 } },
    conflicts: { type: "array", maxItems: 3, items: {
      type: "object", additionalProperties: false,
      properties: { description: { type: "string", minLength: 1, maxLength: 500 }, evidence_ids: evidenceIds },
      required: ["description", "evidence_ids"],
    } },
  },
  required: ["findings", "missing", "conflicts"],
};
const valid = new Ajv({ strict: false }).compile(workerHandoffSchema);

/**
 * 校验 Worker 交接结构及已观察到的来源关系，不把结构合法等同于事实成立。
 *
 *  Check structure and observed provenance; this does not prove semantic entailment.
 *
 * @param value 待校验或转换的值。
 * @param citationIds citation 对应的标识集合。
 * @param observations 工具执行后收集的观察结果。
 * @returns WorkerHandoff 类型的处理结果。
 */
export function validateWorkerHandoff(value: unknown, citationIds: string[],
  observations: Array<{ citation_id: string; content: string }>): WorkerHandoff {
  if (!valid(value)) throw new BadRequestException("步骤交付结构无效，必须提供 findings、missing 和 conflicts");
  const handoff = value as Omit<WorkerHandoff, "coverage">;
  const claims = [...handoff.findings.map(item => item.statement), ...handoff.conflicts.map(item => item.description), ...handoff.missing];
  if (!claims.length || claims.some(text => !text.trim()))
    throw new BadRequestException("步骤交付必须明确事实、缺口或冲突，不能提交空结论");
  const adopted = new Set(citationIds);
  const observed = new Set(observations.filter(item => item.content.trim()).map(item => item.citation_id));
  for (const item of [...handoff.findings, ...handoff.conflicts])
    if (item.evidence_ids.some(id => !adopted.has(id) || !observed.has(id)))
      throw new BadRequestException("步骤交付引用必须属于本步骤实际读取且已采用的证据");
  return { ...structuredClone(handoff), coverage: handoff.conflicts.length ? "conflicted"
    : handoff.missing.length ? handoff.findings.length ? "partial" : "insufficient" : "complete" };
}

/**
 * 整理 Worker 交接校验所需的任务、输出和证据上下文。
 *
 * @param handoff Worker 交接的发现、缺口、冲突与证据。
 * @returns 整理后的状态与操作结果对象。
 */
export function workerHandoffInput(handoff: WorkerHandoff | undefined) {
  if (!handoff) throw new BadRequestException("依赖任务缺少结构化交付");
  const { coverage: _coverage, ...value } = handoff;
  return value;
}
