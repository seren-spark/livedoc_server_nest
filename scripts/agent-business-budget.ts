import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { AgentExecutionError } from '../src/ai/agent-execution.js';

/** One synchronous reservation before each real HTTP request, shared across worker restarts. */
export function reserveBusinessModelRequest(path: string): void {
  const counter = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(counter.requests) || counter.requests < 0)
    throw new AgentExecutionError('EVAL_INVALID_COUNTER', '真实验收调用计数无效，已停止发送请求');
  if (counter.requests >= 100)
    throw new AgentExecutionError('EVAL_REQUEST_LIMIT', '真实验收已达到100次模型请求上限');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ requests: counter.requests + 1 }));
  renameSync(temporary, path);
}
