import { describe, expect, jest, test } from "@jest/globals";
import { AppConfig } from "../src/config/app-config.js";
import { AgentSupervisorService } from "../src/ai/agent-supervisor.service.js";
import {
  emptyUsage,
  type WorkerEnvironment,
  type WorkerOutput,
} from "../src/ai/agent-runtime.types.js";
import { request } from "./fixtures/agent-request.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const output = (): WorkerOutput => ({
  result: { kind: "answer", answer: "summary", citation_ids: [] },
  handoff: { coverage: "insufficient", findings: [], missing: ["没有事实证据"], conflicts: [] },
  citations: [],
  evidence: [],
  observations: [],
  read_region_ids: [],
  selection_read: false,
  usage: emptyUsage(),
});
function harness() {
  const config = new AppConfig();
  const turn = jest.fn<any>();
  const service = new AgentSupervisorService(config, { turn } as any);
  const events: any[] = [];
  const environment: WorkerEnvironment = {
    run_id: "root",
    request: request("ask"),
    context: { user_id: "u", space_id: "s", team_ids: [] },
    personal: {} as any,
    signal: new AbortController().signal,
    budget: emptyUsage(),
    emit: (event, data) => events.push({ event, ...data }),
  };
  const completed: Record<string, WorkerOutput> = Object.create(null);
  const execute = jest.fn<any>().mockImplementation(async (step: any) => {
    completed[step.id] = output();
  });
  const input = {
    environment,
    completed,
    execute,
    trace: service.createTrace(),
    plan: {
      goal: "goal",
      outline: [],
      constraints: ["constraint"],
      steps: [
        {
          id: "a",
          capability: "read" as const,
          description: "read",
          depends_on: [] as string[],
        },
        {
          id: "b",
          capability: "read" as const,
          description: "read",
          depends_on: ["a"],
        },
      ],
    },
  };
  const reply = (decision: unknown) => ({
    role: "assistant",
    content: JSON.stringify(decision),
  });
  return { config, service, turn, input, events, reply };
}

describe("bounded supervisor decisions", () => {
  test("five serial steps retain a read and handoff each without exceeding the default budget", async () => {
    const h = harness();
    h.input.plan.steps = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, capability: "read" as const,
      description: "read then handoff", depends_on: i ? [`s${i - 1}`] : [] }));
    expect(() => h.service.assertPlanFits(h.input.plan)).not.toThrow();
    h.turn.mockImplementation(async (_env: any, messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      return h.reply(payload.ready.length ? { action: "dispatch", task_ids: [payload.ready[0].id] } : { action: "compose" });
    });
    h.input.execute.mockImplementation(async (step: any, limit: number, turns: number) => {
      expect(turns).toBeGreaterThanOrEqual(2);
      h.input.environment.budget.execution_turns += turns;
      expect(h.input.environment.budget.execution_turns).toBeLessThanOrEqual(limit);
      h.input.completed[step.id] = output();
    });
    await h.service.run(h.input);
    expect(h.input.execute).toHaveBeenCalledTimes(5);
    expect(h.input.environment.budget.execution_turns + 2).toBeLessThanOrEqual(h.config.agentMaxToolCalls);
    const limited = harness();
    Object.defineProperty(limited.config, "agentMaxToolCalls", { value: 12 });
    expect(limited.service.maxPlanSteps()).toBe(2);
    expect(() => limited.service.assertPlanFits(h.input.plan)).toThrow("最多支持 2 步");
    expect(limited.turn).not.toHaveBeenCalled();
  });

  test("rejects optional supplement that would consume mandatory compose and final delivery turns", async () => {
    const h = harness();
    Object.defineProperty(h.config, "agentMaxToolCalls", { value: 12 });
    h.input.plan.steps = [h.input.plan.steps[1]!];
    (h.input.plan.steps[0] as any).capability = "compose";
    h.input.completed.a = output();
    h.input.environment.budget.execution_turns = 6;
    h.input.environment.request.references = [{ id: "note", title: "note", kind: "text", content: "proof" }];
    h.turn.mockImplementationOnce(async (_env: any, messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      expect(payload.limits.supplement_remaining).toBe(0);
      expect(payload.allowed_actions).not.toContain("supplement");
      return h.reply({ action: "supplement", instruction: "unnecessary", depends_on: ["a"] });
    }).mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["b"] }))
      .mockResolvedValueOnce(h.reply({ action: "compose" }));
    await h.service.run(h.input);
    expect(h.input.execute.mock.calls.map(([step]: any[]) => step.id)).toEqual(["b"]);
    expect(h.input.trace.supplement_count).toBe(0);
  });

  test("parallel research reserves turns for a mandatory intermediate compose and final delivery", async () => {
    const h = harness();
    Object.defineProperty(h.config, "agentMaxToolCalls", { value: 16 });
    h.input.plan.steps[1]!.depends_on = [];
    h.input.plan.steps.push({ id: "c", capability: "compose" as any, description: "merge", depends_on: ["a", "b"] });
    h.turn.mockImplementation(async (_env: any, messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      return h.reply(payload.ready.length ? { action: "dispatch", task_ids: payload.ready.map((step: any) => step.id) }
        : { action: "compose" });
    });
    h.input.execute.mockImplementation(async (step: any, limit: number, turns: number) => {
      expect([limit, turns]).toEqual(step.id === "c" ? [12, 2] : [9, 4]);
      h.input.environment.budget.execution_turns += turns;
      h.input.completed[step.id] = output();
    });
    await h.service.run(h.input);
    expect(h.input.environment.budget.execution_turns).toBe(13);
    expect(h.input.execute).toHaveBeenCalledTimes(3);
  });

  test("retains structured gaps beyond a long answer and chooses clarification from conflicts", async () => {
    const h = harness();
    h.input.plan.steps = h.input.plan.steps.slice(0, 1);
    h.input.execute.mockImplementation(async () => {
      const value = output();
      value.result = { kind: "answer", answer: "irrelevant ".repeat(500), citation_ids: ["a", "b"] };
      value.observations = [{ citation_id: "a", content: "预算120万" }, { citation_id: "b", content: "预算180万" }];
      value.handoff = { coverage: "conflicted", findings: [], missing: ["没有预算版本优先级"],
        conflicts: [{ description: "预算120万与180万冲突", evidence_ids: ["a", "b"] }] };
      h.input.completed.a = value;
    });
    h.turn.mockImplementation(async (_env: any, messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      if (!payload.results.length) return h.reply({ action: "dispatch", task_ids: ["a"] });
      expect(payload.tasks[0].status).toBe("succeeded");
      expect(payload.results[0]).not.toHaveProperty("summary");
      expect(payload.results[0].handoff).toMatchObject({ coverage: "conflicted",
        missing: ["没有预算版本优先级"], conflicts: [{ evidence_ids: ["a", "b"] }] });
      return h.reply({ action: "clarify", question: "以哪版预算为准？", choices: ["120万", "180万"] });
    });
    await expect(h.service.run(h.input)).resolves.toMatchObject({ kind: "clarification", question: "以哪版预算为准？" });
    expect(h.input.trace.status).toBe("needs_input");
    expect(h.turn).toHaveBeenCalledTimes(2);
  });

  test("missing handoff cannot unlock dependent steps or final composition", async () => {
    const h = harness();
    h.input.execute.mockImplementation(async () => { h.input.completed.a = { ...output(), handoff: undefined }; });
    h.turn.mockResolvedValue(h.reply({ action: "dispatch", task_ids: ["a"] }));
    await expect(h.service.run(h.input)).rejects.toThrow("缺少结构化交付");
    expect(h.input.execute).toHaveBeenCalledTimes(1);
    expect(h.turn).toHaveBeenCalledTimes(1);
  });

  test("repairs premature finalization by explicitly dispatching the intermediate compose task", async () => {
    const h = harness();
    (h.input.plan.steps[1] as any).capability = "compose";
    h.turn
      .mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["a"] }))
      .mockResolvedValueOnce(h.reply({ action: "compose" }))
      .mockImplementationOnce(async (_env: any, messages: any[]) => {
        const payload = JSON.parse(messages[1].content);
        expect(payload.can_compose).toBe(false);
        expect(payload.allowed_actions).not.toContain("compose");
        expect(messages.at(-1).content).toContain('"action":"dispatch","task_ids":["b"]');
        return h.reply({ action: "dispatch", task_ids: ["b"] });
      })
      .mockResolvedValueOnce(h.reply({ action: "compose" }));
    await expect(h.service.run(h.input)).resolves.toBeUndefined();
    expect(h.input.execute.mock.calls.map(([step]: any[]) => step.id)).toEqual(["a", "b"]);
    expect(h.input.trace.repair_count).toBe(1);
  });

  test("dispatches only ready tasks and preserves a confirmed plan with multiple compose steps", async () => {
    const h = harness();
    h.input.plan.steps.forEach((step) => {
      (step as any).capability = "compose";
    });
    const before = structuredClone(h.input.plan);
    h.turn.mockImplementation(
      async (_env: any, messages: any[], tools: any[], options: any) => {
        const payload = JSON.parse(messages[1].content);
        expect(payload.can_compose).toBe(payload.ready.length === 0);
        expect(tools).toEqual([]);
        expect(options).toMatchObject({ role: "plan", json: true });
        expect(payload.plan).toEqual(before);
        return h.reply(
          payload.ready.length
            ? { action: "dispatch", task_ids: [payload.ready[0].id] }
            : { action: "compose" },
        );
      },
    );
    await expect(h.service.run(h.input)).resolves.toBeUndefined();
    expect(h.input.execute.mock.calls.map(([step]: any[]) => step.id)).toEqual([
      "a",
      "b",
    ]);
    expect(h.input.plan).toEqual(before);
    expect(h.input.trace.status).toBe("completed");
    expect(h.input.environment.budget.execution_turns).toBe(3);
  });

  test.each([
    { action: "dispatch", task_ids: ["b"] },
    { action: "dispatch", task_ids: ["a", "a"] },
    { action: "dispatch", task_ids: ["a", "b", "c", "d"] },
    { action: "dispatch", task_ids: ["missing"] },
    { action: "compose" },
    { action: "dispatch", task_ids: ["a"], allow_web: true },
    { action: "finish" },
  ])(
    "rejects unsafe or premature decisions with at most one protocol repair: %j",
    async (decision) => {
      const h = harness();
      h.turn.mockResolvedValue(h.reply(decision));
      await expect(h.service.run(h.input)).rejects.toThrow("主管决策修复失败");
      expect(h.turn).toHaveBeenCalledTimes(2);
      expect(h.input.execute).not.toHaveBeenCalled();
      expect(h.input.trace).toMatchObject({
        status: "failed",
        repair_count: 1,
        decisions: [],
      });
    },
  );

  test("a corrected decision executes once and does not repeat completed work", async () => {
    const h = harness();
    h.turn
      .mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["b"] }))
      .mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["a"] }))
      .mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["b"] }))
      .mockResolvedValueOnce(h.reply({ action: "compose" }));
    await h.service.run(h.input);
    expect(h.input.execute).toHaveBeenCalledTimes(2);
    expect(
      h.input.execute.mock.calls.every(
        ([, limit, turns]: any[]) => limit <= h.config.agentMaxToolCalls - 3 && turns >= 1 && turns <= 4,
      ),
    ).toBe(true);
    expect(h.input.trace.repair_count).toBe(1);
    expect(h.input.environment.budget.execution_turns).toBe(4);
    const repaired = h.turn.mock.calls[1]![1] as any[];
    expect(repaired.at(-1).content).toContain('"action":"dispatch","task_ids":["a"]');
  });

  test("supplement inherits only successful dependencies, has a server ID and cannot repeat", async () => {
    const h = harness();
    h.input.plan.steps = h.input.plan.steps.slice(0, 1);
    h.input.environment.request.references = [
      { id: "note", kind: "text", title: "note", content: "proof" },
    ];
    h.turn
      .mockResolvedValueOnce(h.reply({ action: "dispatch", task_ids: ["a"] }))
      .mockResolvedValueOnce(
        h.reply({
          action: "supplement",
          instruction: "verify missing fact",
          depends_on: ["a"],
        }),
      )
      .mockResolvedValue(
        h.reply({
          action: "supplement",
          instruction: "repeat",
          depends_on: ["a"],
        }),
      );
    await expect(h.service.run(h.input)).rejects.toThrow("补检次数");
    expect(h.input.execute).toHaveBeenCalledTimes(2);
    expect(h.input.execute.mock.calls[1]![0]).toMatchObject({
      id: expect.stringMatching(/^supplement_/),
      capability: "search",
      depends_on: ["a"],
    });
    expect(h.input.plan.steps).toHaveLength(1);
    expect(h.input.trace.supplement_count).toBe(1);
  });

  test.each(["no_scope", "uncompleted_dependency", "max_steps"])(
    "blocks unauthorized supplement: %s",
    async (kind) => {
      const h = harness();
      h.input.completed.a = output();
      if (kind !== "no_scope")
        h.input.environment.request.knowledge_scope = {
          private: true,
          public: false,
          team: false,
          document_ids: [],
        };
      if (kind === "max_steps")
        h.input.plan.steps = [1, 2, 3, 4, 5].map((n) => ({
          id: `p${n}`,
          capability: "read",
          description: "x",
          depends_on: [],
        }));
      h.turn.mockResolvedValue(
        h.reply({
          action: "supplement",
          instruction: "verify",
          depends_on: [kind === "uncompleted_dependency" ? "b" : "a"],
        }),
      );
      await expect(h.service.run(h.input)).rejects.toThrow("主管决策修复失败");
      expect(h.input.execute).not.toHaveBeenCalled();
    },
  );

  test("waits for every result in a failing batch before stopping, without a new decision", async () => {
    const h = harness();
    h.input.plan.steps[1]!.depends_on = [];
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    let started = 0;
    let finished = false;
    h.input.execute.mockImplementation(async (step: any) => {
      if (++started === 2) bothStarted.resolve();
      if (step.id === "a") throw new Error("necessary task failed");
      await release.promise;
      h.input.completed.b = output();
    });
    h.turn.mockResolvedValue(
      h.reply({ action: "dispatch", task_ids: ["a", "b"] }),
    );
    const running = h.service.run(h.input).catch((error) => {
      finished = true;
      throw error;
    });
    const assertion = expect(running).rejects.toThrow("necessary task failed");
    await bothStarted.promise;
    expect(finished).toBe(false);
    release.resolve();
    await assertion;
    expect(h.turn).toHaveBeenCalledTimes(1);
    expect(h.input.trace.status).toBe("failed");
    expect(
      h.events.filter(
        (event) => event.status === "done" && event.id !== "supervisor",
      ),
    ).toEqual([]);
  });

  test("mixed compose batches are rejected and final candidate turns remain reserved", async () => {
    const h = harness();
    h.input.plan.steps[1]!.depends_on = [];
    (h.input.plan.steps[1] as any).capability = "compose";
    h.turn.mockResolvedValue(
      h.reply({ action: "dispatch", task_ids: ["a", "b"] }),
    );
    await expect(h.service.run(h.input)).rejects.toThrow("串行");
    const limited = harness();
    limited.input.environment.budget.execution_turns =
      limited.config.agentMaxToolCalls - 2;
    await expect(limited.service.run(limited.input)).rejects.toThrow(
      "保留最终读取和提交预算",
    );
    expect(limited.turn).not.toHaveBeenCalled();
  });
});
