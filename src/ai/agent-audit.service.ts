import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import type { AccessContext } from "../common/types.js";
export interface AgentRunRecord {
  run_id: string;
  request_id: string;
  user_id: string;
  space_id: string;
  conversation_id: string;
  mode: string;
  status: string;
  payload: Record<string, any>;
}
@Injectable()
export class AgentAuditService {
  readonly runs = new Map<string, AgentRunRecord>();
  readonly calls = new Map<string, any>();
  constructor(private readonly db: DatabaseService) {}
  async begin(run: AgentRunRecord) {
    if([...this.runs.values()].some(r=>r.request_id===run.request_id&&r.user_id===run.user_id&&r.space_id===run.space_id)) throw new ConflictException('同一请求已经启动');
    if (this.db.metadataEnabled) {
      try {
        await this.db.query(
          "INSERT INTO agent_runs(run_id,request_id,user_id,space_id,conversation_id,mode,status,payload) VALUES(?,?,?,?,?,?,?,?)",
          [
            run.run_id,
            run.request_id,
            run.user_id,
            run.space_id,
            run.conversation_id,
            run.mode,
            run.status,
            JSON.stringify(run.payload),
          ],
        );
      } catch (error: any) {
        if (error.code === "ER_DUP_ENTRY")
          throw new ConflictException("同一请求已经启动，请勿重复发送");
        run.payload.audit_store='memory';console.error('Agent run audit unavailable',error);
      }
    } else if (
      [...this.runs.values()].some(
        (r) =>
          r.request_id === run.request_id &&
          r.user_id === run.user_id &&
          r.space_id === run.space_id,
      )
    )
      throw new ConflictException("同一请求已经启动");
    this.runs.set(run.run_id, run);
  }
  async update(run: AgentRunRecord) {
    this.runs.set(run.run_id, run);
    if (this.db.metadataEnabled)
      await this.db.query(
        "UPDATE agent_runs SET status=?,payload=?,completed_at=IF(? IN ('awaiting_review','completed','needs_input','failed','stopped'),NOW(6),NULL) WHERE run_id=?",
        [run.status, JSON.stringify(run.payload), run.status, run.run_id],
      ).catch(error=>{run.payload.audit_store='memory';console.error('Agent run audit unavailable',error);});
  }
  async get(id: string, c: AccessContext): Promise<AgentRunRecord> {
    let run = this.runs.get(id);
    if(run&&run.user_id===c.user_id&&run.space_id===c.space_id) return run;
    if (this.db.metadataEnabled) {
      const rows = await this.db.query<any>(
        "SELECT * FROM agent_runs WHERE run_id=? AND user_id=? AND space_id=?",
        [id, c.user_id, c.space_id],
      );
      if (rows[0])
        run = {
          ...rows[0],
          payload:
            typeof rows[0].payload === "string"
              ? JSON.parse(rows[0].payload)
              : rows[0].payload,
        };
      else run = undefined;
    }
    if (!run || run.user_id !== c.user_id || run.space_id !== c.space_id)
      throw new NotFoundException("任务不存在");
    return run;
  }
  async tool(
    runId: string,
    callId: string,
    name: string,
    source: string,
    status: string,
    payload: Record<string, unknown>,
    stepId?: string,
  ) {
    // Store identifiers/counts only; source text, prompts and credentials never enter tool audit.
    const row = {
      run_id: runId,
      call_id: callId,
      step_id: stepId ?? null,
      tool_name: name,
      source,
      status,
      payload,
    };
    this.calls.set(`${runId}:${callId}`, row);
    if (this.db.metadataEnabled)
      try {
        await this.db.query(
          `INSERT INTO agent_tool_calls(run_id,call_id,step_id,tool_name,source,status,payload) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),payload=VALUES(payload),completed_at=NOW(6)`,
          [
            runId,
            callId,
            stepId ?? null,
            name,
            source,
            status,
            JSON.stringify(payload),
          ],
        );
      } catch (error) {
        console.error("Agent tool audit unavailable", error);
      }
  }
  async list(id: string, c: AccessContext) {
    await this.get(id, c);
    if (this.db.metadataEnabled)
      return this.db.query<any>(
        "SELECT call_id,run_id,step_id,tool_name,source,status,payload,started_at,completed_at FROM agent_tool_calls WHERE run_id=? ORDER BY started_at,call_id",
        [id],
      );
    return [...this.calls.values()].filter((r) => r.run_id === id);
  }
}
