import { describe, test, expect } from "@jest/globals";
import { AppConfig } from "../src/config/app-config.js";
import { AgentMcpService } from "../src/ai/agent-mcp.service.js";
describe("MCP lifecycle", () => {
  test("discovers the actual local Fetch schema and rejects private addresses before execution", async () => {
    const config = new AppConfig();
    Object.defineProperty(config, "mcpEnabled", { value: true });
    Object.defineProperty(config, "mcpServers", { value: {} });
    const manager = new AgentMcpService(config);
    try {
      await manager.onModuleInit();
      expect(manager.unavailable).toEqual([]);
      expect([...manager.tools.keys()]).toEqual(["mcp__fetch__fetch"]);
      await expect(
        manager.call(
          "mcp__fetch__fetch",
          { url: "http://127.0.0.1/" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("拒绝");
      expect(
        manager.tools.get("mcp__fetch__fetch")?.schema.function.parameters
          .required,
      ).toContain("url");
    } finally {
      await manager.onModuleDestroy();
    }
  }, 30000);
});
