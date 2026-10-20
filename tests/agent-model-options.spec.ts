import { describe, test, expect, jest } from "@jest/globals";
import { AppConfig } from "../src/config/app-config.js";
import { LlmService } from "../src/ai/llm.service.js";
describe("agent model configuration", () => {
  test("thinking changes the actual main-model payload and stays off for the critic", async () => {
    const config = new AppConfig();
    Object.defineProperties(config, {
      llmApiKey: { value: "test" },
      llmModel: { value: "main" },
      agentCriticModel: { value: "critic" },
      thinkingSupported: { value: true },
      thinkingOnBody: { value: { enable_thinking: true } },
      thinkingOffBody: { value: { enable_thinking: false } },
    });
    const bodies: any[] = [];
    const mock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) => {
        bodies.push(JSON.parse(String(options?.body)));
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: { content: "{}", reasoning_content: "private chain" },
              },
            ],
            usage: {},
          }),
        } as any;
      });
    try {
      const llm = new LlmService(config);
      const result = await llm.agentTurn(
        [{ role: "user", content: "x" }],
        [{ type: 'function', function: { name: 'finish_answer', description: 'answer', parameters: { type: 'object' } } }],
        undefined,
        { thinking: true },
      );
      await llm.agentTurn([{ role: "user", content: "x" }], [], undefined, {
        role: "critic",
        thinking: true,
      });
      expect(bodies[0]).toMatchObject({ model: "main", enable_thinking: true, tool_choice: 'auto' });
      expect(bodies[1]).toMatchObject({
        model: "critic",
        enable_thinking: false,
      });
      expect(result.message).not.toHaveProperty("reasoning_content");
    } finally {
      mock.mockRestore();
    }
  });
  test('native search forces retrieval and uses provider source metadata, not prose URLs', async () => {
    const config = new AppConfig();
    Object.defineProperties(config, { llmApiKey: { value: 'test' }, agentWebSearchUrl: { value: 'https://provider.example/search' }, agentWebSearchModel: { value: 'search-model' } });
    let body: any;
    const mock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(url).toBe('https://provider.example/search');
      body = JSON.parse(String(options?.body));
      return { ok: true, json: async () => ({ output: {
        choices: [{ message: { content: [{ text: 'Fact [1]. Unverified https://invented.example' }] } }],
        search_info: { search_results: [{ index: 1, title: 'Actual source', url: 'https://source.example/page' }, { index: 2, url: 'javascript:alert(1)' }] },
      } }) } as any;
    });
    try {
      const llm = new LlmService(config);
      expect(await llm.searchWeb('query')).toEqual({ summary: 'Fact [1]. Unverified https://invented.example', sources: [{ index: 1, title: 'Actual source', url: 'https://source.example/page' }] });
      expect(body).toMatchObject({ model: 'search-model', parameters: { enable_thinking: false, enable_search: true, search_options: { forced_search: true, enable_source: true } } });
      mock.mockResolvedValueOnce({ ok: true, json: async () => ({ output: { choices: [{ message: { content: 'https://invented.example' } }] } }) } as any);
      await expect(llm.searchWeb('query')).rejects.toThrow('未返回可追溯来源');
    } finally { mock.mockRestore(); }
  });
});
