import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AiWriteDto } from '../common/dto.js';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class LlmService {
  constructor(private readonly config: AppConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config.llmApiKey);
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const data = await this.request(
      {
        model: this.config.llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      },
      signal,
    );
    return String(data.choices?.[0]?.message?.content ?? '');
  }

  async *stream(prompt: string, signal?: AbortSignal): AsyncGenerator<string> {
    this.ensureConfigured();
    const response = await fetch(`${this.config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: this.config.llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`LLM request failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        const delta = JSON.parse(raw).choices?.[0]?.delta?.content;
        if (delta) yield String(delta);
      }
      if (done) break;
    }
  }

  async selectTool(request: AiWriteDto, tools: unknown[]): Promise<{ name: string; arguments: Record<string, any>; reason: string }> {
    const data = await this.request({
      model: this.config.llmModel,
      messages: [
        {
          role: 'system',
          content:
            '你是 LiveDoc 工具路由器。必须选择且只选择一个工具；不得直接回答用户。需要检索时，query_variants 最多三个；代码符号、版本号、专有名词和引号内容必须原样保留。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            query: request.query,
            retrieval_domain: request.retrieval_domain,
            has_current_document: Boolean(request.current_document),
            selected_text: request.current_context.selected_text.slice(0, 500),
            cursor_before: request.current_context.cursor_before.slice(-500),
          }),
        },
      ],
      tools,
      tool_choice: 'required',
      temperature: 0,
      stream: false,
    });
    const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!call) throw new Error('Model did not return a tool call');
    const args = JSON.parse(call.arguments || '{}') as Record<string, any>;
    return { name: String(call.name), arguments: args, reason: String(args.reason ?? '模型 Function Call 选择') };
  }

  async expandQueries(query: string, context: string, maxVariants: number): Promise<string[]> {
    const tool = {
      type: 'function',
      function: {
        name: 'expand_search_queries',
        description: '生成保持原意的检索查询变体。',
        parameters: {
          type: 'object',
          properties: { queries: { type: 'array', items: { type: 'string' }, maxItems: maxVariants } },
          required: ['queries'],
        },
      },
    };
    const data = await this.request({
      model: this.config.llmModel,
      messages: [
        {
          role: 'system',
          content: '只生成检索改写，不回答问题。保持原始语义；代码符号、版本号、专有名词和引号内容必须原样保留。',
        },
        { role: 'user', content: JSON.stringify({ query, context: context.slice(-800) }) },
      ],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: 'expand_search_queries' } },
      temperature: 0,
      stream: false,
    });
    const raw = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!raw) return [];
    const values = JSON.parse(raw).queries;
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === 'string') : [];
  }

  private async request(body: unknown, signal?: AbortSignal): Promise<any> {
    this.ensureConfigured();
    const timeout = AbortSignal.timeout(this.config.llmTimeoutSeconds * 1000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: combined,
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    return response.json();
  }

  private ensureConfigured(): void {
    if (!this.config.llmApiKey) throw new ServiceUnavailableException('LLM_API_KEY is required for /ai/write.');
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.llmApiKey}`, 'Content-Type': 'application/json' };
  }
}
