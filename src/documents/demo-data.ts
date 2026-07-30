import type { DocumentIndexRequest } from './document.types.js';

export const DEMO_DOCUMENTS: DocumentIndexRequest[] = [
  {
    doc_id: 'public_rag_basics', space_id: 'public', title: '企业 RAG 问答设计原则',
    content: '# 企业 RAG 问答设计原则\n\n可靠的知识库问答应先执行权限过滤，再进行向量召回与重排。模型只能看到用户有权访问的片段。\n\n## 引用透明\n\n回答应展示文档标题、匹配片段和相关度，并使用编号把结论关联到原始资料。',
    visibility: 'public', source_type: 'public_article', tags: ['RAG', '引用', '企业知识库'],
    team_id: null, owner_id: null, url: '/article/public_rag_basics', document_version: 1,
  },
  {
    doc_id: 'alice_private_writing', space_id: 'space_a', owner_id: 'user_alice', title: 'Alice 的产品写作笔记',
    content: 'Alice 的私有写作方法强调先列证据，再组织结论，最后补充可执行建议。', visibility: 'private',
    source_type: 'note', tags: ['写作', '私有资料'], team_id: null, url: '/article/alice_private_writing', document_version: 1,
  },
  {
    doc_id: 'bob_private_canvas', space_id: 'space_a', owner_id: 'user_bob', title: 'Bob 的 Canvas 性能记录',
    content: 'Canvas 高密度渲染可通过虚拟轨道、分帧更新和 OffscreenCanvas 降低主线程压力。', visibility: 'private',
    source_type: 'note', tags: ['Canvas', '性能'], team_id: null, url: '/article/bob_private_canvas', document_version: 1,
  },
  {
    doc_id: 'carol_private_research', space_id: 'space_a', owner_id: 'user_carol', title: 'Carol 的调研记录',
    content: '调研结论需要保留样本范围、时间窗口和数据来源，避免把相关性误写为因果关系。', visibility: 'private',
    source_type: 'note', tags: ['调研', '数据'], team_id: null, url: '/article/carol_private_research', document_version: 1,
  },
  {
    doc_id: 'team_alpha_rag_spec', space_id: 'space_a', owner_id: null, team_id: 'team_alpha', title: 'Alpha 团队 RAG 检索规范',
    content: 'Alpha 团队要求向量载荷包含 owner_id、team_id 和 document_version，并在检索阶段完成服务端权限过滤。',
    visibility: 'team', source_type: 'team_doc', tags: ['RAG', '权限隔离'], url: '/article/team_alpha_rag_spec', document_version: 1,
  },
  {
    doc_id: 'team_beta_release_notes', space_id: 'space_a', owner_id: null, team_id: 'team_beta', title: 'Beta 团队发布检查清单',
    content: 'Beta 团队发布前需要完成回归测试、变更记录、监控告警和回滚方案检查。', visibility: 'team',
    source_type: 'team_doc', tags: ['发布', '检查清单'], url: '/article/team_beta_release_notes', document_version: 1,
  },
];
