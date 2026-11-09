import assert from "node:assert/strict";
import {
  Annotation,
  StateGraph,
  START,
  END,
  interrupt,
  Command,
  RunControl,
  isGraphDrained,
} from "@langchain/langgraph";
import initializer from "./graph-checkpointer-initializer.js";
import { MySqlCheckpointSaver } from "../src/ai/graph/mysql-checkpoint-saver.js";

await initializer.beforeAll();
try {
  const saver = await initializer.createCheckpointer();
  const calls = { prepare: 0, left: 0, right: 0 };
  let failRight = true;
  const state = Annotation.Root({
    results: Annotation<Record<string, string>>({
      reducer: (a, b) => ({ ...a, ...b }),
      default: () => ({}),
    }),
  });
  const builder = new StateGraph(state)
    .addNode("prepare", () => {
      calls.prepare++;
      return {};
    })
    .addNode("approval", () => {
      assert.equal(interrupt("confirm"), true);
      return {};
    })
    .addNode("left", () => {
      calls.left++;
      return { results: { left: "saved" } };
    })
    .addNode("right", () => {
      calls.right++;
      if (failRight) throw new Error("controlled interruption");
      return { results: { right: "saved" } };
    })
    .addEdge(START, "prepare")
    .addEdge("prepare", "approval")
    .addEdge("approval", "left")
    .addEdge("approval", "right")
    .addEdge("left", END)
    .addEdge("right", END);
  const config = {
    configurable: { thread_id: "restart-smoke" },
    durability: "sync" as const,
  };
  const first = builder.compile({ checkpointer: saver });
  const waiting = await first.invoke({}, config);
  assert.equal((waiting as any).__interrupt__?.length, 1);
  await assert.rejects(
    first.invoke(new Command({ resume: true }), config),
    /controlled interruption/,
  );
  // Recreate both the DB connection and saver, preserving only database rows.
  await initializer.afterAll();
  await initializer.beforeAll();
  // createCheckpointer deliberately clears tests; open an un-cleared instance instead.
  const { DataSource } = await import("typeorm");
  const url = new URL(
    process.env.GRAPH_TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  url.pathname = "/livedoc_langgraph_test";
  const connection = new DataSource({ type: "mysql", url: url.toString() });
  await connection.initialize();
  try {
    const storage = {
      query: (sql: string, p?: unknown[]) => connection.query(sql, p),
      transaction: (work: any) => connection.transaction(work),
    } as any;
    failRight = false;
    const restored = builder.compile({
      checkpointer: new MySqlCheckpointSaver(storage),
    });
    const result = await restored.invoke(null, config);
    assert.deepEqual(result.results, { left: "saved", right: "saved" });
    assert.deepEqual(calls, { prepare: 1, left: 1, right: 2 });
    const control = new RunControl();
    const pauseGraph = new StateGraph(
      Annotation.Root({ count: Annotation<number>() }),
    )
      .addNode("one", () => {
        control.requestDrain("user-pause");
        return { count: 1 };
      })
      .addNode("two", () => ({ count: 2 }))
      .addEdge(START, "one")
      .addEdge("one", "two")
      .addEdge("two", END)
      .compile({ checkpointer: new MySqlCheckpointSaver(storage) });
    const pauseConfig = {
      configurable: { thread_id: "drain-smoke" },
      durability: "sync" as const,
    };
    await assert.rejects(
      pauseGraph.invoke({}, { ...pauseConfig, control }),
      isGraphDrained,
    );
    assert.equal((await pauseGraph.getState(pauseConfig)).values.count, 1);
    assert.equal((await pauseGraph.invoke(null, pauseConfig)).count, 2);
    console.log(
      "MySQL graph smoke passed: interrupt, connection restart, pending parallel writes, drain and resume.",
    );
  } finally {
    await connection.destroy();
  }
} finally {
  await initializer.afterAll();
}
