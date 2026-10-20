import type { DocumentRecord } from "../documents/document.types.js";
export interface NoteCategory {
  category_id: string;
  space_id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  deleted_at: string | null;
  delete_batch_id: string | null;
  delete_reason: "user" | "merged" | null;
}
export interface NoteTemplate {
  template_id: string;
  name: string;
  description: string;
  markdown: string;
  instructions: string;
  revision: number;
  builtin?: boolean;
}
export interface CategoryState {
  revision: number;
  categories: NoteCategory[];
  documents: DocumentRecord[];
}
export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  {
    template_id: "builtin-meeting",
    name: "会议纪要",
    description: "议题、决策与行动项",
    markdown:
      "# 会议纪要\n\n## 会议背景\n\n## 讨论要点\n\n## 结论与决策\n\n## 行动项\n\n| 事项 | 负责人 | 截止日期 |\n| --- | --- | --- |",
    instructions: "仅记录资料中明确的决策、人员与日期，缺失信息标为待确认。",
    revision: 1,
    builtin: true,
  },
  {
    template_id: "builtin-technical",
    name: "技术方案",
    description: "目标、设计与验证",
    markdown:
      "# 技术方案\n\n## 背景与目标\n\n## 约束与边界\n\n## 设计方案\n\n## 实施步骤\n\n## 验证与风险",
    instructions: "说明设计取舍，区分已知事实和待验证假设。",
    revision: 1,
    builtin: true,
  },
  {
    template_id: "builtin-learning",
    name: "学习笔记",
    description: "概念、例子与总结",
    markdown:
      "# 学习笔记\n\n## 核心概念\n\n## 原理与示例\n\n## 常见问题\n\n## 总结与练习",
    instructions: "先解释概念，再给出具体例子。",
    revision: 1,
    builtin: true,
  },
  {
    template_id: "builtin-review",
    name: "项目复盘",
    description: "过程、结果与改进",
    markdown:
      "# 项目复盘\n\n## 目标与结果\n\n## 关键过程\n\n## 问题与原因\n\n## 经验与改进",
    instructions: "不编造指标，改进行动应具体且可执行。",
    revision: 1,
    builtin: true,
  },
];
