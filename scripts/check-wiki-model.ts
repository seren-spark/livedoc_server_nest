// Synthetic capability probe only. No documents, database or user prompts.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
const config = new AppConfig();
const llm = new LlmService(config);
const report: Record<string, unknown> = {
  model: config.llmModel,
  host: new URL(config.llmBaseUrl).hostname,
  simulated: false,
  synthetic_only: true,
  checked_at: new Date().toISOString(),
};
try {
  assert.equal(config.llmModel, "qwen3.7-flash-2026-07-15");
  const json = await llm.agentTurn(
    [
      { role: "system", content: 'Only return JSON {"ok":true}.' },
      { role: "user", content: "Test JSON output." },
    ],
    [],
    AbortSignal.timeout(20000),
    { role: "critic", json: true, maxTokens: 100 },
  );
  assert.equal(JSON.parse(json.message.content!).ok, true);
  report.json = "passed";
  const tool = await llm.agentTurn(
    [
      {
        role: "user",
        content: "Calculate 17+25 and call report_result with the answer.",
      },
    ],
    [
      {
        type: "function",
        function: {
          name: "report_result",
          description: "Report integer answer",
          parameters: {
            type: "object",
            properties: { answer: { type: "integer" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    ],
    AbortSignal.timeout(20000),
    { maxTokens: 150 },
  );
  assert.equal(tool.message.tool_calls?.[0]?.function.name, "report_result");
  assert.equal(
    JSON.parse(tool.message.tool_calls![0]!.function.arguments).answer,
    42,
  );
  report.function_calling = "passed";
} catch (error) {
  report.error =
    error instanceof Error ? error.message.slice(0, 450) : "probe failed";
  process.exitCode = 1;
} finally {
  await writeFile(
    "../docs/wiki-quality-model-probe.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
