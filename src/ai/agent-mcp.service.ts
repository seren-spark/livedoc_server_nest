import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import type { FunctionTool } from "./document-agent.types.js";
import { validatePublicUrl } from "./public-web-fetch.js";
@Injectable()
export class AgentMcpService implements OnModuleInit, OnModuleDestroy {
  private readonly clients = new Map<string, Client>();
  readonly tools = new Map<
    string,
    { schema: FunctionTool; server: string; name: string }
  >();
  readonly unavailable: string[] = [];
  constructor(private readonly config: AppConfig) {}
  async onModuleInit() {
    if (!this.config.mcpEnabled) return;
    const compiled = resolve(
      this.config.projectRoot,
      "dist/ai/mcp-fetch-server.js",
    );
    const settings: Record<string, any> = {
      fetch: {
        transport: "stdio",
        command: process.execPath,
        args: existsSync(compiled)
          ? [compiled]
          : [
              "--import",
              "tsx",
              resolve(this.config.projectRoot, "src/ai/mcp-fetch-server.ts"),
            ],
        tools_include: ["fetch"],
        enabled: true,
      },
      ...this.config.mcpServers,
    };
    for (const [name, setting] of Object.entries(settings)) {
      if (
        !setting.enabled ||
        !Array.isArray(setting.tools_include) ||
        !setting.tools_include.length ||
        !/^[a-zA-Z0-9_-]+$/.test(name)
      )
        continue;
      const env: Record<string, string> = {};
      const expand = (value: unknown) =>
        String(value).replace(
          /\$\{([^}]+)\}/g,
          (_m, key) => process.env[key] ?? "",
        );
      for (const [key, value] of Object.entries(setting.env ?? {}))
        env[key] = String(value).replace(
          /\$\{([^}]+)\}/g,
          (_m, key) => process.env[key] ?? "",
        );
      if (
        name === "tavily" &&
        setting.transport === "stdio" &&
        !env.TAVILY_API_KEY
      ) {
        this.unavailable.push(name);
        continue;
      }
      const client = new Client({ name: "livedoc-agent", version: "1.0.0" });
      try {
        const transport =
          setting.transport === "stdio"
            ? new StdioClientTransport({
                command: setting.command,
                args: setting.args ?? [],
                env: {
                  ...getDefaultEnvironment(),
                  ...env,
                },
              })
            : new StreamableHTTPClientTransport(new URL(expand(setting.url)), {
                requestInit: {
                  headers: Object.fromEntries(
                    Object.entries(setting.headers ?? {}).map(
                      ([key, value]) => [key, expand(value)],
                    ),
                  ),
                },
              });
        await client.connect(transport, { timeout: 10000 });
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const list = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: 10000,
          });
          for (const tool of list.tools)
            if (setting.tools_include.includes(tool.name)) {
              const raw = `mcp__${name}__${tool.name}`;
              const id = /^[a-zA-Z0-9_-]{1,64}$/.test(raw)
                ? raw
                : `${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 54)}_${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
              if (this.tools.has(id)) throw new Error("MCP 工具名重复");
              this.tools.set(id, {
                server: name,
                name: tool.name,
                schema: {
                  type: "function",
                  function: {
                    name: id,
                    description: tool.description ?? tool.name,
                    parameters: tool.inputSchema,
                  },
                },
              });
            }
          cursor = list.nextCursor;
          if (cursor) {
            if (seenCursors.has(cursor)) throw new Error("MCP 分页游标重复");
            seenCursors.add(cursor);
          }
        } while (cursor);
        this.clients.set(name, client);
      } catch (error) {
        for (const [id, tool] of this.tools)
          if (tool.server === name) this.tools.delete(id);
        this.unavailable.push(name);
        console.warn(
          `MCP ${name} unavailable`,
          error instanceof Error ? error.name : "connection_failed",
        );
        await client.close().catch(() => undefined);
      }
    }
  }
  async call(id: string, args: Record<string, any>, signal: AbortSignal) {
    signal.throwIfAborted();
    const tool = this.tools.get(id);
    if (!tool) throw new Error("MCP 工具未启用");
    for (const field of ["url", "urls"])
      if (args[field])
        for (const url of Array.isArray(args[field])
          ? args[field]
          : [args[field]])
          await validatePublicUrl(String(url));
    signal.throwIfAborted();
    const result = await this.clients
      .get(tool.server)!
      .callTool({ name: tool.name, arguments: args }, undefined, {
        signal,
        timeout: 30000,
      });
    if (result.isError) throw new Error("MCP 工具返回错误");
    const content = (result.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return content;
  }
  async onModuleDestroy() {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }
}
