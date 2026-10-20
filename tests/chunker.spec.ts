import {
  buildChunkPassage,
  chunkMarkdown,
  estimateTokens,
  MAX_CHUNK_TOKENS,
  OVERLAP_TOKENS,
} from "../src/retrieval/chunker.js";

describe("production Markdown chunking", () => {
  test("keeps section content and heading metadata aligned", () => {
    const markdown = [
      "# 第一章",
      "",
      "总体说明。",
      "",
      "## 安装",
      "",
      "安装说明。",
      "",
      "## 检索",
      "",
      "检索说明。",
    ].join("\n");

    const chunks = chunkMarkdown("doc", "手册", markdown);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.heading_path)).toEqual([
      ["第一章"],
      ["第一章", "安装"],
      ["第一章", "检索"],
    ]);
    expect(chunks[0]!.content).not.toContain("安装说明");
    expect(chunks[1]!.content).not.toContain("检索说明");
    for (const chunk of chunks) {
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(
        chunk.content,
      );
    }
  });

  test("uses the Markdown AST for Setext headings and source offsets", () => {
    const markdown = "安装指南\n========\n\n正文内容。";
    const [chunk] = chunkMarkdown("doc", "手册", markdown);

    expect(chunk).toMatchObject({
      heading_path: ["安装指南"],
      start_offset: 0,
      end_offset: markdown.length,
    });
    expect(chunk!.content).toBe(markdown);
  });

  test("splits oversized prose within the complete passage budget", () => {
    const markdown = `# 长文\n\n${"这是一个用于检索的完整句子。".repeat(180)}`;
    const chunks = chunkMarkdown("doc", "生产手册", markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading_path.join("/") === "长文")).toBe(
      true,
    );
    for (const chunk of chunks) {
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(
        MAX_CHUNK_TOKENS,
      );
    }

    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      const overlap = markdown.slice(current.start_offset, previous.end_offset);
      expect(estimateTokens(overlap)).toBeLessThanOrEqual(OVERLAP_TOKENS);
    }
  });

  test("reports a single oversized code line without cutting its tokens", () => {
    const markdown = `# 代码\n\n\`\`\`ts\n${"constValue".repeat(700)}\n\`\`\``;
    expect(() => chunkMarkdown("doc", "开发手册", markdown)).toThrow(/line exceeding/u);
  });

  test("bounds pathological title and heading metadata", () => {
    const title = "标题".repeat(300);
    const heading = "章节".repeat(300);
    const markdown = `# ${heading}\n\n${"正文。".repeat(300)}`;
    const chunks = chunkMarkdown("doc", title, markdown);

    expect(chunks.length).toBeLessThan(10);
    expect(chunks.every((chunk) => chunk.heading_path[0] === heading)).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          estimateTokens(buildChunkPassage(chunk)) <= MAX_CHUNK_TOKENS,
      ),
    ).toBe(true);
  });

  test("does not carry overlap across section boundaries", () => {
    const markdown = `# 第一章\n\n${"甲。".repeat(300)}\n\n# 第二章\n\n${"乙。".repeat(300)}`;
    const chunks = chunkMarkdown("doc", "手册", markdown);
    const firstSecondChapter = chunks.findIndex(
      (chunk) => chunk.heading_path[0] === "第二章",
    );

    expect(firstSecondChapter).toBeGreaterThan(0);
    expect(chunks[firstSecondChapter]!.content).not.toContain("甲");
    expect(chunks[firstSecondChapter - 1]!.content).not.toContain("第二章");
  });

  test("estimates CJK and Latin text without the old language bias", () => {
    expect(estimateTokens("中".repeat(100))).toBe(100);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("honors per-index chunk budgets instead of hidden constants", () => {
    const markdown = `# 配置化切分\n\n${"这是用于验证切分预算的句子。".repeat(80)}`;
    const chunks = chunkMarkdown("doc", "手册", markdown, {
      maxTokens: 96,
      overlapTokens: 12,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => estimateTokens(buildChunkPassage(chunk)) <= 96),
    ).toBe(true);
  });

  test("uses GFM table row boundaries for oversized tables", () => {
    const rows = Array.from(
      { length: 30 },
      (_, index) => `| ${index} | 第 ${index} 行的结构化说明 |`,
    );
    const markdown = [
      "# 参数表",
      "",
      "| 编号 | 说明 |",
      "| --- | --- |",
      ...rows,
    ].join("\n");
    const chunks = chunkMarkdown("doc", "接口手册", markdown, {
      maxTokens: 96,
      overlapTokens: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(
        chunk.content,
      );
      expect(
        chunk.start_offset === 0 || markdown[chunk.start_offset - 1] === "\n",
      ).toBe(true);
      expect(
        chunk.end_offset === markdown.length ||
          markdown[chunk.end_offset] === "\n",
      ).toBe(true);
      expect(chunk.retrieval_content ?? chunk.content).toContain("| 编号 | 说明 |");
      expect(chunk.retrieval_content ?? chunk.content).toContain("| --- | --- |");
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(96);
    }
  });

  test("keeps fitting TypeScript functions complete and restores fences in every fragment", () => {
    const functions = Array.from({ length: 6 }, (_, index) =>
      `// function ${index}\nexport function handler${index}(value: number) {\n  const next = value + ${index};\n  return next * 2;\n}`);
    const markdown = `# 示例\n\n\`\`\`ts\n${functions.join("\n\n")}\n\`\`\``;
    const chunks = chunkMarkdown("doc", "代码", markdown, { maxTokens: 120, overlapTokens: 24 });
    for (const fn of functions) {
      expect(chunks.some((chunk) => (chunk.retrieval_content ?? chunk.content).includes(fn))).toBe(true);
    }
    for (const chunk of chunks.filter((chunk) => chunk.retrieval_content?.includes("代码片段"))) {
      expect(chunk.retrieval_content).toMatch(/```ts\n[\s\S]*\n```/u);
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.content);
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(120);
    }
  });

  test("splits a long function at statement boundaries with its function name", () => {
    const statements = Array.from({ length: 20 }, (_, index) => `  const value${index} = input + ${index};`);
    const markdown = `\`\`\`typescript\nfunction calculate(input: number) {\n${statements.join("\n")}\n  return value19;\n}\n\`\`\``;
    const chunks = chunkMarkdown("doc", "代码", markdown, { maxTokens: 128, overlapTokens: 32 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(chunks.some((chunk) => chunk.content.includes(statement.trim()))).toBe(true);
    }
    expect(chunks.slice(0, -1).every((chunk) => chunk.retrieval_content?.includes("所属函数：calculate"))).toBe(true);
    expect(chunks.every((chunk) => estimateTokens(buildChunkPassage(chunk)) <= 128)).toBe(true);
  });

  test("uses full lines for unsupported languages and incomplete code", () => {
    for (const language of ["python", "js"]) {
      const lines = Array.from({ length: 15 }, (_, index) => `print('value${index}') # example`);
      const markdown = `\`\`\`${language}\n${lines.join("\n")}\n\`\`\``;
      const chunks = chunkMarkdown("doc", "代码", markdown, { maxTokens: 96, overlapTokens: 12 });
      for (const line of lines) expect(chunks.some((chunk) => chunk.content.includes(line))).toBe(true);
      expect(chunks.every((chunk) => (chunk.retrieval_content ?? chunk.content).includes(`\`\`\`${language}`))).toBe(true);
    }
  });

  test("keeps each list item and its nested steps together when it fits", () => {
    const items = Array.from({ length: 7 }, (_, index) => `${index + 1}. 配置步骤 ${index}\n   - 设置地址 ${index}\n   - 检查连接 ${index}`);
    const markdown = `# 操作手册\n\n${items.join("\n")}`;
    const chunks = chunkMarkdown("doc", "手册", markdown, { maxTokens: 96, overlapTokens: 24 });
    for (const item of items) expect(chunks.some((chunk) => chunk.content.includes(item))).toBe(true);
    expect(chunks.every((chunk) => markdown.slice(chunk.start_offset, chunk.end_offset) === chunk.content)).toBe(true);
  });

  test("retains parent labels and task checkboxes when splitting an oversized nested list item", () => {
    const children = Array.from({ length: 12 }, (_, index) => `   - [${index % 2 ? "x" : " "}] 设置子步骤 ${index}，检查连接和配置。`);
    const markdown = `2. 配置数据库\n${children.join("\n")}`;
    const chunks = chunkMarkdown("doc", "操作", markdown, { maxTokens: 120, overlapTokens: 24 });
    for (const child of children) expect(chunks.some((chunk) => chunk.content.includes(child.trim()))).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.retrieval_content ?? chunk.content).toContain("配置数据库");
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(120);
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.content);
    }
  });

  test("turns an oversized table row into labelled fields with stable row identity", () => {
    const markdown = `| 参数 | 说明 |\n| --- | --- |\n| timeout | ${"这是完整的字段说明。".repeat(35)} |`;
    const chunks = chunkMarkdown("doc", "参数", markdown, { maxTokens: 96, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.retrieval_content ?? chunk.content).includes("表格第 1 行"))).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk.retrieval_content?.includes("字段：说明"))).toBe(true);
    expect(chunks.every((chunk) => chunk.retrieval_content?.includes("timeout"))).toBe(true);
    expect(chunks.every((chunk) => markdown.slice(chunk.start_offset, chunk.end_offset) === chunk.content)).toBe(true);
    expect(chunks.every((chunk) => estimateTokens(buildChunkPassage(chunk)) <= 96)).toBe(true);
  });

  test("protects inline formulas, inline code and links in long paragraphs and overlap", () => {
    const formula = "$\\frac{a.b}{c} + x_{i} = y$";
    const code = "`value.foo(); value.bar()`";
    const link = "[使用说明](https://example.com/api?v=1.2)";
    const markdown = Array.from({ length: 8 }, () => `前置条件。使用 ${formula}，调用 ${code}，参考 ${link}。`).join("");
    const chunks = chunkMarkdown("doc", "公式", markdown, { maxTokens: 128, overlapTokens: 32 });
    for (const atom of [formula, code, link]) {
      expect(chunks.some((chunk) => chunk.content.includes(atom))).toBe(true);
    }
    for (const chunk of chunks) {
      expect(((chunk.retrieval_content ?? chunk.content).match(/\$/gu)?.length ?? 0) % 2).toBe(0);
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.content);
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(128);
    }
  });

  test("keeps a block formula, its introduction and variable definitions accessible", () => {
    const formula = "$$\n\\begin{aligned}\na &= b + c \\\\\nd &= a^2\n\\end{aligned}\n$$";
    const markdown = `# 推导\n\n${"背景说明。".repeat(30)}\n\n以下计算目标值。\n\n${formula}\n\n其中 a 为目标值，b 和 c 为输入。`;
    const chunks = chunkMarkdown("doc", "数学", markdown, { maxTokens: 128, overlapTokens: 24 });
    const evidence = chunks.find((chunk) => (chunk.retrieval_content ?? chunk.content).includes(formula));
    expect(evidence).toBeDefined();
    expect(evidence!.retrieval_content ?? evidence!.content).toContain("以下计算目标值");
    expect(evidence!.retrieval_content ?? evidence!.content).toContain("其中 a 为目标值");
    expect(chunks.every((chunk) => estimateTokens(buildChunkPassage(chunk)) <= 128)).toBe(true);
  });

  test("reports oversized formulas and diagrams without indexing incomplete syntax", () => {
    expect(() => chunkMarkdown("doc", "公式", `$$\n${"x + ".repeat(300)}y\n$$`)).toThrow(/Atomic math/u);
    expect(() => chunkMarkdown("doc", "图", `\`\`\`mermaid\ngraph TD\n${"A --> B\n".repeat(200)}\`\`\``)).toThrow(/Diagram/u);
  });

  test("carries reference definitions into retrieval text without changing source offsets", () => {
    const markdown = `# 参考\n\n${"背景说明。".repeat(70)}\n\n请参阅 [接口手册][api] 和说明[^note]。\n\n[api]: https://example.com/api\n\n[^note]: 参数以实际配置为准。`;
    const chunks = chunkMarkdown("doc", "手册", markdown, { maxTokens: 128, overlapTokens: 24 });
    const citation = chunks.find((chunk) => chunk.content.includes("[接口手册][api]"))!;
    expect(citation.retrieval_content).toContain("[api]: https://example.com/api");
    expect(citation.retrieval_content).toContain("[^note]: 参数以实际配置为准。");
    expect(markdown.slice(citation.start_offset, citation.end_offset)).toBe(citation.content);
  });

  test("binds image references to a nearby caption and protects the full image URL", () => {
    const image = "![索引流程](https://example.com/assets/flow.png)";
    const markdown = `${"背景说明。".repeat(40)}\n\n${image}\n\n图一：索引任务由 Worker 分批执行。`;
    const chunks = chunkMarkdown("doc", "插图", markdown, { maxTokens: 128, overlapTokens: 16 });
    const evidence = chunks.find((chunk) => chunk.content.includes(image))!;
    expect(evidence.retrieval_content ?? evidence.content).toContain("图一：索引任务");
    expect(markdown.slice(evidence.start_offset, evidence.end_offset)).toBe(evidence.content);
  });

  test("retains quote attribution while splitting long quoted paragraphs", () => {
    const markdown = `> ${"这是引用中的完整观点。".repeat(80)}\n>\n> 来源：操作手册。`;
    const chunks = chunkMarkdown("doc", "引用", markdown, { maxTokens: 128, overlapTokens: 16 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.retrieval_content ?? chunk.content).includes("引用片段："))).toBe(true);
    expect(chunks.every((chunk) => markdown.slice(chunk.start_offset, chunk.end_offset) === chunk.content)).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("来源：操作手册"))).toBe(true);
    expect(chunks.every((chunk) => chunk.retrieval_content?.includes("来源：操作手册"))).toBe(true);
  });

  test("keeps class methods complete when they fit and includes class ownership", () => {
    const methods = Array.from({ length: 5 }, (_, index) =>
      `  method${index}(input: number) {\n    return input + ${index};\n  }`);
    const markdown = `\`\`\`ts\nclass Calculator {\n${methods.join("\n")}\n}\n\`\`\``;
    const chunks = chunkMarkdown("doc", "代码", markdown, { maxTokens: 120, overlapTokens: 16 });
    for (const method of methods) expect(chunks.some((chunk) => chunk.content.includes(method))).toBe(true);
    expect(chunks.every((chunk) => estimateTokens(buildChunkPassage(chunk)) <= 120)).toBe(true);
  });

  test("rebuilds safe fences for tilde code blocks containing backticks and preserves metadata", () => {
    const lines = Array.from({ length: 30 }, (_, index) => "const value" + index + " = '```';");
    const markdown = `~~~js title=example\r\n${lines.join("\r\n")}\r\n~~~`;
    const chunks = chunkMarkdown("doc", "代码", markdown, { maxTokens: 120, overlapTokens: 0 });
    for (const chunk of chunks) {
      expect(chunk.retrieval_content).toContain('````js title=example');
      expect(markdown.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.content);
      expect(estimateTokens(buildChunkPassage(chunk))).toBeLessThanOrEqual(120);
    }
  });
});
