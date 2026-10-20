import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchPublicPage } from "./public-web-fetch.js";
const server = new McpServer({
  name: "livedoc-public-fetch",
  version: "1.0.0",
});
server.registerTool(
  "fetch",
  {
    description:
      "读取公网 HTTP/HTTPS 文字网页，转换为 Markdown，拒绝私网地址与不安全重定向。",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }, extra) => {
    const page = await fetchPublicPage(url, extra.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(page) }] };
  },
);
await server.connect(new StdioServerTransport());
