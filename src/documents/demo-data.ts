import type { AccessContext } from '../common/types.js';
import type { DocumentIndexRequest } from './document.types.js';

const DEMO_DOCUMENT_INPUTS: Array<
  Omit<DocumentIndexRequest, 'document_updated_at'>
> = [
  {
    doc_id: 'public_livedoc_workflow_demo',
    space_id: 'public',
    title: 'LiveDoc 可溯源问答与协同写作演示',
    content: `# LiveDoc 可溯源问答与协同写作演示

这篇公开资料用于演示知识库问答、Agent 工具选择、流式预览和确认写入的完整链路。系统不会把模型输出直接拼接进编辑器，而是先把结果放进独立预览区；只有用户点击“接受并插入”后，前端才把经过转换的 TipTap JSON 写入正文。这样可以避免模型输出破坏标题、列表、代码块等原有文档结构。

## 四个 Agent 工具

LiveDoc 只保留四个容易理解和演示的工具：search_knowledge_base 用于检索知识库；summarize_current_document 用于总结当前文档；continue_paragraph 用于结合光标上下文续写；optimize_format 用于优化选区格式。工具由大模型 Function Call 选择，参数必须通过 JSON Schema 和 DTO 校验，知识库片段只作为不可信证据传入，不能覆盖系统指令。

## SSE 执行过程

前端通过 SSE 展示轻量执行步骤。事件顺序为 meta、tool_start、tool_result、delta、citations、done；异常时发送 error。每个事件都携带 request_id 和 trace_id。has_evidence 仅表示本次回答是否检索到知识库证据，can_insert 单独表示结果当前能否写入编辑器，两者不能混为一谈。

## 引用与确认写入

知识库回答中的引用编号只能来自本次检索结果。生成结束后，后端会移除不存在、越界或未在正文中使用的引用。引用卡片保存 doc_id、document_version、chunk_id、source_anchor 和原文片段，用户点击后可以打开对应版本并高亮来源。证据不足时系统必须明确说明无法依据现有资料回答，不能编造看似可信的引用。
`,
    visibility: 'public',
    source_type: 'public_article',
    tags: ['演示数据', 'Agent', 'SSE', '确认写入'],
    team_id: null,
    owner_id: null,
    url: '/article/public_livedoc_workflow_demo',
    document_version: 1,
  },
  {
    doc_id: 'alice_private_writing',
    space_id: 'space_a',
    owner_id: 'user_alice',
    title: 'Alice 的真实 RAG 链路验收手册',
    content: `# Alice 的真实 RAG 链路验收手册

这篇私有文档用于验证 Alice 账户只能检索自己的资料。私有演示文档中的检索验收口令是 **TEAL-ANCHOR-731**。测试精确事实问答时，应询问验收口令，并检查回答是否带有指向本段的引用，而不是只检查模型是否碰巧答对。

## 检索流水线

Alice 的 RAG 演示链路依次执行：查询改写、BGE dense embedding、Qdrant dense 与 IDF sparse 双路召回、RRF 融合、BGE reranker 重排、上下文压缩、带来源证据生成。dense 召回擅长语义相似表达，IDF sparse 召回更容易命中型号、口令和专有名词；RRF 只负责融合不同排名，最终相关性仍由 reranker 校正。

## 标题结构与递归切分

文档先按 Markdown 标题保留 heading_path，再在过长章节内按段落、句子和 token 预算递归切分，并保留适量 overlap。每个 chunk 携带 chunk_id、doc_id、document_version、ordinal、heading_path、source_anchor、权限和标签。LiveDoc 当前不默认启用父子索引，因为演示文档规模较小，标题路径与相邻上下文已经足够；如果评测发现小块召回准确但生成上下文残缺，再增加 parent_chunk_id 和父块回填，而不是为了技术名词提前增加复杂度。

## 版本化索引

文档更新时先为新 document_version 生成完整向量，全部写入成功后再原子激活新版本，随后清理旧版本。检索只读取 active_index_version，因此不会看到半成品。旧引用如果指向过期版本，界面应提示版本已变化并展示保存的 snippet，不能悄悄定位到新版中含义不同的段落。

## 验收检查

一次完整验收需要同时观察工具选择、dense 与 sparse 候选数、RRF 融合数、rerank 结果、引用编号合法性和点击回链。只看到一段自然语言答案不代表 RAG 链路已经通过。
`,
    visibility: 'private',
    source_type: 'note',
    tags: ['演示数据', '真实RAG', 'Alice私有', '引用验收'],
    team_id: null,
    url: '/article/alice_private_writing',
    document_version: 1,
  },
  {
    doc_id: 'bob_private_canvas',
    space_id: 'space_a',
    owner_id: 'user_bob',
    title: 'Bob 的 Canvas 性能记录',
    content:
      'Canvas 高密度渲染可通过虚拟轨道、分帧更新和 OffscreenCanvas 降低主线程压力。该文档用于验证 Alice 无法检索 Bob 的私有内容。',
    visibility: 'private',
    source_type: 'note',
    tags: ['权限隔离', 'Bob私有'],
    team_id: null,
    url: '/article/bob_private_canvas',
    document_version: 1,
  },
  {
    doc_id: 'carol_private_research',
    space_id: 'space_a',
    owner_id: 'user_carol',
    title: 'Carol 的调研记录',
    content:
      '调研结论需要保留样本范围、时间窗口和数据来源，避免把相关性误写为因果关系。该文档用于验证私有知识库的用户隔离。',
    visibility: 'private',
    source_type: 'note',
    tags: ['权限隔离', 'Carol私有'],
    team_id: null,
    url: '/article/carol_private_research',
    document_version: 1,
  },
  {
    doc_id: 'team_alpha_rag_spec',
    space_id: 'space_a',
    owner_id: null,
    team_id: 'team_alpha',
    title: 'Alpha 团队引用溯源与拒答规范',
    content: `# Alpha 团队引用溯源与拒答规范

本规范只对 team_alpha 成员可见，用于验证团队权限过滤。向量载荷必须包含 owner_id、team_id、space_id、document_version 和 active 状态；权限过滤必须在 Qdrant 检索阶段由服务端完成，不能先召回越权内容再依赖前端隐藏。

## 引用数据契约

每条可展示引用包含 citation_id、index、doc_id、document_version、chunk_id、title、heading_path、snippet、source_anchor、retrieval_score 和 rerank_score。回答完成后只保留正文实际使用、编号合法且属于本次候选集的引用。前端点击引用时打开 doc_id 对应文档，并依据 source_anchor 或 chunk_id 定位和高亮原文。

## 文档版本变化

引用必须绑定生成回答时的 document_version。若当前文档版本与引用版本不同，界面展示“来源版本已过期”，同时保留当时的 snippet 供用户核对。禁止把旧引用自动映射到新版相似文本，因为相似段落可能已经改变结论，错误定位会让溯源看起来成立但事实并不成立。

## 证据不足与拒答

当检索结果为空、重排分数低于证据阈值，或命中片段不能支持问题中的关键结论时，系统应回答“现有知识库资料不足，无法给出有依据的结论”，并建议补充资料或调整检索范围。不得利用模型常识补齐答案后再附上无关引用。团队拒答验收短语是 **EVIDENCE-FIRST-204**。

## 前端展示要求

用户应能看到正在分析任务、所选工具、是否执行知识库检索、来源数量、生成状态和引用校验结果。界面使用轻量步骤条即可，不需要复杂工作流画布。
`,
    visibility: 'team',
    source_type: 'team_doc',
    tags: ['演示数据', 'team_alpha', '引用溯源', '拒答'],
    url: '/article/team_alpha_rag_spec',
    document_version: 1,
  },
  {
    doc_id: 'team_beta_release_notes',
    space_id: 'space_a',
    owner_id: null,
    team_id: 'team_beta',
    title: 'Beta 团队发布检查清单',
    content:
      'Beta 团队发布前需要完成回归测试、变更记录、监控告警和回滚方案检查。该文档用于验证 team_alpha 成员无法检索 team_beta 资料。',
    visibility: 'team',
    source_type: 'team_doc',
    tags: ['权限隔离', 'team_beta'],
    url: '/article/team_beta_release_notes',
    document_version: 1,
  },
];

export const DEMO_DOCUMENTS: DocumentIndexRequest[] = DEMO_DOCUMENT_INPUTS.map(
  (document) => ({
    ...document,
    document_updated_at: '2026-08-10T00:00:00.000Z',
  }),
);

export function isDemoDocumentVisibleTo(
  document: DocumentIndexRequest,
  context: AccessContext,
): boolean {
  if (document.visibility === 'public') return true;
  if (document.space_id !== context.space_id) return false;
  if (document.visibility === 'private') {
    return document.owner_id === context.user_id;
  }
  return Boolean(
    document.team_id && context.team_ids.includes(document.team_id),
  );
}
