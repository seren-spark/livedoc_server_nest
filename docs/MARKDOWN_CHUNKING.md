# Markdown 结构分块

入口为 `src/retrieval/chunker.ts`。持久知识库、当前文档问答、分段摘要和文档记忆共用该实现。默认 embedding passage 上限为 420 token，正文预算会扣除标题和标题路径；普通文本 overlap 上限为 64 token。

## 结构规则

| 类型 | 规则 |
| --- | --- |
| 段落 | 完整段落优先，超长按句子组合，最后才对普通文本按字符回退；保护行内公式、代码、图片和链接 |
| 代码 | 短代码块完整保留；JS/TS/JSX/TSX 使用 TypeScript AST 优先保留函数、方法及语句边界；其他语言或解析失败的示例使用完整行 |
| 表格 | 按完整数据行组合，每片重复表头及分隔行；超长行按带行号、记录值和列名的字段拆分 |
| 列表 | 按完整 listItem（包含子项）组合；单项超长时递归拆内部结构，补上原始父项文字和编号，保留任务勾选状态 |
| 数学公式 | 解析 `$…$` 和 `$$…$$`；行内公式不可拆，块级公式整体保留，并在预算允许时带邻近引导句与变量说明 |
| 图片 | 图片引用不可拆；独立图片在预算允许时带邻近图注。这里只索引文本说明，不解析图片内部信息 |
| 引用 | 超长引用按内部结构拆分，片段带引用标记 |
| 引用式链接/脚注 | 在使用片段中附上对应定义，不单独索引孤立定义 |
| Mermaid / PlantUML / DOT | 保持完整图表，不使用普通代码行回退 |

拆开的代码会补齐 Markdown 围栏、原语言和 meta，并明确标记为局部片段；跨多个函数的片段不标注成属于单个函数。对可识别的函数片段补充函数名称和参数签名。代码片段不保证可以独立运行。

超长单行代码、单个公式/矩阵、完整图表或不可拆的行内节点无法放入预算时，会抛出带原因的错误。索引任务沿用现有 failed 状态和错误展示，不写入被截坏的向量。当前不会自动解析 LaTeX 推导步骤或为每种代码语言引入解析器。

overlap 只取同章节普通段落的完整句子，装不下则减少重叠；结构片段通过表头、父项和函数信息补上下文，不复制零碎尾部字符。

## 原文与检索文本

- `Chunk.content` 始终对应原文的 `start_offset` / `end_offset` 连续切片。
- `Chunk.retrieval_content`（可选）用于补充表头、围栏、父项和引用定义。标题与路径加在其前面生成 embedding passage。
- 向量 payload 与 Citation 的 `content` 为检索/模型文本，`source_content` 保留原始片段。前端引用定位使用原文片段和原文 offset。
- 原文 offset 不计算补充内容长度。Chunk hash 包含补充上下文，父项/表头变更也会改变片段身份。

检索入库仍通过 embedding 服务的 tokenizer 校验最终 passage，超限时缩小预算重拆。测试模式 hash provider 使用估算计数。

## 上下文压缩

压缩器使用相同结构拆分规则，但按生成模型的 tokenizer 计数。表格会重复表头，代码会补齐围栏，列表会携带父项；按查询相关性选择这些片段，并计算拼接后的实际 token 数。预算不足以容纳的不可拆节点会跳过，不能输出半个公式或残缺图表。`source_content` 和 offset 在压缩后仍保持原值。

## 更新已有索引

升级后新建、更新或重新索引的文档采用新规则。已有 Qdrant points 不会自动改写，需要在知识库中重新索引文档。旧 payload 没有 `source_content` 时沿用 `content`，保持兼容。

## 验证

```powershell
npm test -- --runTestsByPath tests/chunker.spec.ts tests/structure-retrieval.spec.ts tests/document-summary.spec.ts tests/dual-memory.spec.ts tests/parity.unit.spec.ts
npm run type-check
npm run build
```
