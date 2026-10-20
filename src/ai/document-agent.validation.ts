import { BadRequestException } from "@nestjs/common";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { DocumentAgentDto } from "./document-agent.dto.js";
import type { AgentCitation, AgentResult, ExecutionPlan } from "./document-agent.types.js";

export function selectAgentCitations(result: AgentResult, available: Map<string, AgentCitation>): AgentCitation[] {
  const ids = result.kind === "answer" || result.kind === "document"
    ? result.citation_ids
    : result.kind === "edits" ? result.edits.flatMap((edit) => edit.citation_ids) : [];
  return [...new Set(ids)].map((id) => {
    const citation = available.get(id);
    if (!citation) throw new BadRequestException("结果引用未知资料");
    return citation;
  });
}

export function parseModelJson(text: string): any {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
}
export function validatePlan(value: any): ExecutionPlan {
  if (
    !value ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 5 ||
    !Array.isArray(value.outline) ||
    value.outline.some((v: unknown) => typeof v !== "string") ||
    !Array.isArray(value.constraints) ||
    value.constraints.some((v: unknown) => typeof v !== "string")
  )
    throw new BadRequestException("计划结构无效");
  const ids = new Set(value.steps.map((s: any) => s.id));
  if (ids.size !== value.steps.length)
    throw new BadRequestException("计划步骤标识重复");
  const done = new Set<string>();
  while (done.size < ids.size) {
    const ready = value.steps.filter(
      (s: any) =>
        !done.has(s.id) &&
        Array.isArray(s.depends_on) &&
        s.depends_on.every((id: string) => done.has(id)),
    );
    if (!ready.length)
      throw new BadRequestException("计划依赖存在循环或无效标识");
    for (const step of ready) {
      if (
        typeof step.id !== "string" ||
        !step.id ||
        typeof step.description !== "string" ||
        !step.description ||
        !["read", "search", "compose"].includes(step.capability)
      )
        throw new BadRequestException("计划步骤无效");
      done.add(step.id);
    }
  }
  return value;
}
export function validateAgentRequest(request: DocumentAgentDto) {
  const snapshot = request.editor_snapshot;
  if (
    !snapshot ||
    snapshot.json?.type !== "doc" ||
    (snapshot.json.content !== undefined &&
      !Array.isArray(snapshot.json.content)) ||
    typeof snapshot.title !== "string" ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Array.isArray(snapshot.regions) ||
    !snapshot.identity ||
    !["knowledge", "article", "import", "unsaved"].includes(
      snapshot.identity.kind,
    ) ||
    !snapshot.selection ||
    !Array.isArray(snapshot.selection.region_ids) ||
    typeof snapshot.selection.text !== "string" ||
    typeof snapshot.selection.inline !== "boolean"
  )
    throw new BadRequestException("编辑器快照无效");
  const ids = new Set<string>();
  snapshot.regions.forEach((r, i) => {
    if (
      !r ||
      typeof r.id !== "string" ||
      ids.has(r.id) ||
      typeof r.text !== "string" ||
      typeof r.markdown !== "string" ||
      !Array.isArray(r.heading_path) ||
      r.heading_path.some((v) => typeof v !== "string") ||
      JSON.stringify(r.original_json) !==
        JSON.stringify(snapshot.json.content?.[i])
    )
      throw new BadRequestException("快照区域与正文不一致");
    ids.add(r.id);
  });
  if (
    snapshot.regions.length !== (snapshot.json.content?.length ?? 0) ||
    snapshot.selection.region_ids.some((id) => !ids.has(id))
  )
    throw new BadRequestException("快照区域数量无效");
  const identity = snapshot.identity;
  if (
    identity.kind === "knowledge" &&
    (!identity.doc_id || !Number.isInteger(identity.persisted_version))
  )
    throw new BadRequestException("知识文档身份无效");
  if (
    identity.kind === "article" &&
    (!identity.article_id || !Number.isInteger(identity.draft_version))
  )
    throw new BadRequestException("文章身份无效");
  if (identity.kind === "import" && !identity.import_id)
    throw new BadRequestException("导入身份无效");
  if (identity.kind === "unsaved" && !identity.local_id)
    throw new BadRequestException("未保存文档身份无效");
  const refs = new Set<string>();
  for (const ref of request.references) {
    if (
      !ref ||
      typeof ref.id !== "string" ||
      refs.has(ref.id) ||
      !["text", "document", "import"].includes(ref.kind) ||
      typeof ref.title !== "string"
    )
      throw new BadRequestException("参考资料无效");
    refs.add(ref.id);
    if (
      ref.kind === "text" &&
      (typeof ref.content !== "string" ||
        Buffer.byteLength(ref.content) > 2 * 1024 * 1024)
    )
      throw new BadRequestException("文本资料超出限制");
    if (
      (ref.kind === "document" && !ref.doc_id) ||
      (ref.kind === "import" && !ref.import_id)
    )
      throw new BadRequestException("资料标识缺失");
  }
  if (request.knowledge_scope) {
    for (const field of ["public", "private", "team"] as const)
      if (
        request.knowledge_scope[field] !== undefined &&
        typeof request.knowledge_scope[field] !== "boolean"
      )
        throw new BadRequestException("知识库范围无效");
    if (
      request.knowledge_scope.document_ids !== undefined &&
      (!Array.isArray(request.knowledge_scope.document_ids) ||
        request.knowledge_scope.document_ids.some((v) => typeof v !== "string"))
    )
      throw new BadRequestException("知识库文档范围无效");
  }
  if (request.confirmed_plan) validatePlan(request.confirmed_plan);
}
export function validateAgentResult(
  result: any,
  request: DocumentAgentDto,
  citationIds: Set<string>,
): AgentResult {
  if (!result || typeof result.kind !== "string")
    throw new BadRequestException("结果缺少类型");
  const citations = (ids: any) => {
    if (
      !Array.isArray(ids) ||
      ids.some(
        (id: unknown) =>
          typeof id !== "string" || !citationIds.has(id as string),
      )
    )
      throw new BadRequestException("结果引用未知资料");
  };
  const markdown = (value: any) => {
    if (typeof value !== "string" || !value.trim() || value.length > 200000)
      throw new BadRequestException("生成内容包含不允许的格式或新图片");
    const visit = (node: any) => {
      if (["image", "imageReference", "html"].includes(node.type))
        throw new BadRequestException(
          "不支持原始 HTML 或新增图片，请将代码放入代码块",
        );
      if (["link", "definition"].includes(node.type)) {
        let url: URL;
        try {
          url = new URL(node.url, "https://livedoc.invalid");
        } catch {
          throw new BadRequestException("链接地址无效");
        }
        if (!["http:", "https:", "mailto:"].includes(url.protocol))
          throw new BadRequestException("不允许此链接协议");
      }
      node.children?.forEach(visit);
    };
    visit(fromMarkdown(value));
  };
  if (result.kind === "clarification") {
    if (
      typeof result.question !== "string" ||
      !result.question.trim() ||
      !Array.isArray(result.choices) ||
      result.choices.some((v: unknown) => typeof v !== "string")
    )
      throw new BadRequestException("澄清问题无效");
  } else if (result.kind === "answer") {
    if (typeof result.answer !== "string" || !result.answer.trim())
      throw new BadRequestException("回答为空");
    citations(result.citation_ids);
    if (request.mode === "plan")
      throw new BadRequestException("Plan 模式需要提交计划");
  } else if (result.kind === "plan") {
    validatePlan(result.plan);
    if (request.mode !== "plan")
      throw new BadRequestException("此轮需要回答或执行计划");
  } else if (result.kind === "document") {
    if (request.mode !== "agent" || request.output_target !== "new_document")
      throw new BadRequestException("当前模式不能生成新文稿");
    if (
      typeof result.title !== "string" ||
      !result.title.trim() ||
      result.title.length > 512
    )
      throw new BadRequestException("文稿标题无效");
    markdown(result.markdown);
    citations(result.citation_ids);
  } else if (result.kind === "edits") {
    if (
      request.mode !== "agent" ||
      request.output_target !== "current_document" ||
      !Array.isArray(result.edits) ||
      !result.edits.length ||
      result.edits.length > 100
    )
      throw new BadRequestException("当前模式或修改建议无效");
    const regions = request.editor_snapshot.regions;
    const ranges: Array<[number, number]> = [];
    const editIds = new Set<string>();
    const boundaries = new Set<string>();
    for (const edit of result.edits) {
      if (
        !edit ||
        typeof edit.id !== "string" ||
        editIds.has(edit.id) ||
        !["insert_before", "insert_after", "replace", "delete"].includes(
          edit.operation,
        ) ||
        typeof edit.explanation !== "string"
      )
        throw new BadRequestException("修改建议参数无效");
      editIds.add(edit.id);
      citations(edit.citation_ids);
      if (edit.operation !== "delete") markdown(edit.content_markdown);
      if (
        !edit.target ||
        !["block_range", "selection", "cursor"].includes(edit.target.kind)
      )
        throw new BadRequestException("修改目标无效");
      if (edit.target.kind === "block_range") {
        const from = regions.findIndex(
          (r) => r.id === edit.target.first_region_id,
        );
        const to = regions.findIndex(
          (r) =>
            r.id ===
            (edit.target.last_region_id ?? edit.target.first_region_id),
        );
        if (from < 0 || to < from)
          throw new BadRequestException("修改目标不存在");
        if (
          edit.operation === "replace" &&
          edit.content_markdown.replace(/\r\n/g, "\n").trim() ===
            regions
              .slice(from, to + 1)
              .map((region) => region.markdown)
              .join("\n\n")
              .replace(/\r\n/g, "\n")
              .trim()
        )
          throw new BadRequestException(
            "替换内容与原文相同，没有实际修改；请移除此建议，无需修改时用 finish_answer 说明",
          );
        if (edit.operation.startsWith("insert")) {
          const k = String(edit.operation === "insert_before" ? from : to + 1);
          if (boundaries.has(k))
            throw new BadRequestException("同一边界插入需要合并");
          boundaries.add(k);
        } else ranges.push([from, to]);
      } else {
        if (
          edit.target.kind === "selection" &&
          (!request.editor_snapshot.selection.text ||
            !request.editor_snapshot.selection.inline ||
            !["replace", "delete"].includes(edit.operation))
        )
          throw new BadRequestException("仅支持单文本块内选区替换");
        if (
          edit.target.kind === "cursor" &&
          !edit.operation.startsWith("insert")
        )
          throw new BadRequestException("光标仅支持插入");
        if (boundaries.has(edit.target.kind))
          throw new BadRequestException("同一目标只能生成一个建议");
        boundaries.add(edit.target.kind);
        for (const id of request.editor_snapshot.selection.region_ids) {
          const i = regions.findIndex((r) => r.id === id);
          if (i >= 0) ranges.push([i, i]);
        }
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((r, i) => i > 0 && ranges[i - 1]![1] >= r[0]))
      throw new BadRequestException("修改范围重叠");
    for (const boundary of boundaries)
      if (
        /^\d+$/.test(boundary) &&
        ranges.some(([a, b]) => Number(boundary) > a && Number(boundary) <= b)
      )
        throw new BadRequestException("插入位置与替换范围重叠");
  } else throw new BadRequestException("未知结果类型");
  return result;
}
