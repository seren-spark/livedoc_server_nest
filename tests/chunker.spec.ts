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

  test("hard-splits a single oversized code line", () => {
    const markdown = `# 代码\n\n\`\`\`ts\n${"constValue".repeat(700)}\n\`\`\``;
    const chunks = chunkMarkdown("doc", "开发手册", markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading_path[0] === "代码")).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          estimateTokens(buildChunkPassage(chunk)) <= MAX_CHUNK_TOKENS,
      ),
    ).toBe(true);
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
    }
  });
});
