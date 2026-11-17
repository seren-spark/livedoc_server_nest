/**
 * @file MySQL 图检查点。实现 LangGraph 检查点读写接口，保存线程状态和中间写入。
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite,
  type ChannelVersions,
} from "@langchain/langgraph-checkpoint";
import type { EntityManager } from "typeorm";
import type { DatabaseService } from "../../database/database.service.js";

export const CHECKPOINT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_graph_checkpoints (
    thread_id VARCHAR(128) NOT NULL, ns_key CHAR(64) NOT NULL,
    checkpoint_ns TEXT NOT NULL, checkpoint_id VARCHAR(64) NOT NULL,
    parent_id VARCHAR(64) NULL, checkpoint_type VARCHAR(32) NOT NULL,
    checkpoint LONGBLOB NOT NULL, metadata_type VARCHAR(32) NOT NULL,
    metadata LONGBLOB NOT NULL,
    PRIMARY KEY(thread_id,ns_key,checkpoint_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS agent_graph_writes (
    thread_id VARCHAR(128) NOT NULL, ns_key CHAR(64) NOT NULL,
    checkpoint_id VARCHAR(64) NOT NULL, task_id VARCHAR(128) NOT NULL,
    write_idx INT NOT NULL, task_path TEXT NOT NULL, channel TEXT NOT NULL,
    value_type VARCHAR(32) NOT NULL, value LONGBLOB NOT NULL,
    PRIMARY KEY(thread_id,ns_key,checkpoint_id,task_id,write_idx)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

type Storage = Pick<DatabaseService, "query" | "transaction">;
type Fence = (manager: EntityManager, config: RunnableConfig) => Promise<void>;
/**
 * 将检查点命名空间转换为数据库使用的稳定键。
 *
 * @param ns 检查点命名空间。
 * @returns 整理后的文本或标识。
 */
const nsKey = (ns: string) => createHash("sha256").update(ns).digest("hex");

/** Full checkpoint/pending-write storage. The optional fence runs in the write transaction. */
export class MySqlCheckpointSaver extends BaseCheckpointSaver {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param db 共享数据库服务。
   * @param fence 检查执行代次与写入权限的事务约束（可选）。
   */
  constructor(
    private readonly db: Storage,
    private readonly fence?: Fence,
  ) {
    super();
  }

  /**
   * 准备检查点保存所需的数据库表。
   */
  async setup() {
    for (const sql of CHECKPOINT_SCHEMA) await this.db.query(sql);
  }

  /**
   * 从数据库记录还原 LangGraph 检查点元组。
   *
   * @param row 数据库查询返回的一行数据。
   * @returns CheckpointTuple 类型的处理结果。
   */
  private async tuple(row: any): Promise<CheckpointTuple> {
    const config = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };
    const writes = await this.db.query<any>(
      "SELECT * FROM agent_graph_writes WHERE thread_id=? AND ns_key=? AND checkpoint_id=?",
      [row.thread_id, row.ns_key, row.checkpoint_id],
    );
    writes.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.write_idx),
        writesSortKey(b.task_path, b.task_id, b.write_idx),
      ),
    );
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpoint_type,
      row.checkpoint,
    )) as Checkpoint;
    if (row.parent_id) {
      const parent = await this.getTuple({
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_id,
        },
      });
      if (parent)
        for (const [channel, version] of Object.entries(
          checkpoint.channel_versions,
        )) {
          if (
            !(channel in checkpoint.channel_values) &&
            parent.checkpoint.channel_versions[channel] === version &&
            channel in parent.checkpoint.channel_values
          )
            checkpoint.channel_values[channel] =
              parent.checkpoint.channel_values[channel];
        }
    }
    // Compatibility with v1-v3 checkpoints required by the public saver contract.
    if (checkpoint.v < 4 && row.parent_id) {
      const parentWrites = await this.db.query<any>(
        "SELECT * FROM agent_graph_writes WHERE thread_id=? AND ns_key=? AND checkpoint_id=? AND channel='__pregel_tasks' ORDER BY task_id,write_idx",
        [row.thread_id, row.ns_key, row.parent_id],
      );
      checkpoint.channel_values ??= {};
      checkpoint.channel_values.__pregel_tasks = await Promise.all(
        parentWrites.map((w) => this.serde.loadsTyped(w.value_type, w.value)),
      );
      checkpoint.channel_versions ??= {};
      checkpoint.channel_versions.__pregel_tasks = Object.keys(
        checkpoint.channel_versions,
      ).length
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
    }
    return {
      config,
      checkpoint,
      metadata: (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata,
      )) as CheckpointMetadata,
      pendingWrites: await Promise.all(
        writes.map(
          async (w) =>
            [
              w.task_id,
              w.channel,
              await this.serde.loadsTyped(w.value_type, w.value),
            ] as [string, string, unknown],
        ),
      ),
      ...(row.parent_id
        ? {
            parentConfig: {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_id,
              },
            },
          }
        : {}),
    };
  }

  /**
   * 读取指定检查点及其待处理写入。
   *
   * @param config 运行配置。
   * @returns CheckpointTuple 类型的处理结果；未找到或不可用时可能为空。
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const c = config.configurable ?? {};
    const rows = await this.db.query<any>(
      `SELECT * FROM agent_graph_checkpoints WHERE thread_id=? AND ns_key=?${c.checkpoint_id ? " AND checkpoint_id=?" : ""} ORDER BY checkpoint_id DESC LIMIT 1`,
      [
        c.thread_id,
        nsKey(c.checkpoint_ns ?? ""),
        ...(c.checkpoint_id ? [c.checkpoint_id] : []),
      ],
    );
    return rows[0] ? this.tuple(rows[0]) : undefined;
  }

  /**
   * 按线程、命名空间和查询条件枚举历史检查点。
   *
   * @param config 运行配置。
   * @param options 控制本次行为的可选配置。
   * @returns 按执行顺序逐步产出的进度事件或处理结果。
   */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const c = config.configurable ?? {};
    const conditions: string[] = [],
      params: unknown[] = [];
    if (c.thread_id !== undefined) {
      conditions.push("thread_id=?");
      params.push(c.thread_id);
    }
    if (c.checkpoint_ns !== undefined) {
      conditions.push("ns_key=?");
      params.push(nsKey(c.checkpoint_ns));
    }
    if (c.checkpoint_id) {
      conditions.push("checkpoint_id=?");
      params.push(c.checkpoint_id);
    }
    if (options.before?.configurable?.checkpoint_id) {
      conditions.push("checkpoint_id<?");
      params.push(options.before.configurable.checkpoint_id);
    }
    const rows = await this.db.query<any>(
      `SELECT * FROM agent_graph_checkpoints${conditions.length ? " WHERE " + conditions.join(" AND ") : ""} ORDER BY checkpoint_id DESC`,
      params,
    );
    let remaining = options.limit ?? Infinity;
    for (const row of rows) {
      if (remaining <= 0) break;
      const tuple = await this.tuple(row);
      if (
        options.filter &&
        !Object.entries(options.filter).every(([k, v]) =>
          isDeepStrictEqual(
            (tuple.metadata as Record<string, unknown> | undefined)?.[k],
            v,
          ),
        )
      )
        continue;
      remaining--;
      yield tuple;
    }
  }

  /**
   * 保存检查点与变更的状态通道，返回后续读取所需的配置。
   *
   * @param config 运行配置。
   * @param checkpoint 待读取或写入的图检查点。
   * @param metadata 来源、权限或版本等附加元数据。
   * @param newVersions 本次写入完成后的文档版本。
   * @returns RunnableConfig<Record<string, any>> 类型的处理结果。
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions = checkpoint.channel_versions,
  ): Promise<RunnableConfig> {
    const c = config.configurable ?? {};
    if (!c.thread_id) throw new Error("Checkpoint thread_id is required");
    const changed = {
      ...checkpoint,
      channel_values: Object.fromEntries(
        Object.entries(checkpoint.channel_values).filter(
          ([key]) => key in newVersions,
        ),
      ),
    };
    const [cp, meta] = await Promise.all([
      this.serde.dumpsTyped(changed),
      this.serde.dumpsTyped(metadata),
    ]);
    await this.db.transaction(async (manager) => {
      await this.fence?.(manager, config);
      await manager.query(
        `INSERT INTO agent_graph_checkpoints
        (thread_id,ns_key,checkpoint_ns,checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata)
        VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE checkpoint_type=VALUES(checkpoint_type),checkpoint=VALUES(checkpoint),metadata_type=VALUES(metadata_type),metadata=VALUES(metadata)`,
        [
          c.thread_id,
          nsKey(c.checkpoint_ns ?? ""),
          c.checkpoint_ns ?? "",
          checkpoint.id,
          c.checkpoint_id ?? null,
          cp[0],
          Buffer.from(cp[1]),
          meta[0],
          Buffer.from(meta[1]),
        ],
      );
    });
    return {
      configurable: {
        thread_id: c.thread_id,
        checkpoint_ns: c.checkpoint_ns ?? "",
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * 保存节点在检查点之间产生的中间写入。
   *
   * @param config 运行配置。
   * @param writes writes 参数（PendingWrite[]）。
   * @param taskId task 对应的唯一标识。
   * @param taskPath taskPath 参数。
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    const c = config.configurable ?? {};
    if (!c.thread_id || !c.checkpoint_id)
      throw new Error("Pending writes require thread_id and checkpoint_id");
    const values = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return {
          channel,
          idx: WRITES_IDX_MAP[channel] ?? idx,
          type,
          bytes: Buffer.from(bytes),
        };
      }),
    );
    await this.db.transaction(async (manager) => {
      await this.fence?.(manager, config);
      for (const w of values)
        await manager.query(
          `INSERT INTO agent_graph_writes
        (thread_id,ns_key,checkpoint_id,task_id,write_idx,task_path,channel,value_type,value)
        VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
        task_path=IF(write_idx<0,VALUES(task_path),task_path),channel=IF(write_idx<0,VALUES(channel),channel),
        value_type=IF(write_idx<0,VALUES(value_type),value_type),value=IF(write_idx<0,VALUES(value),value)`,
          [
            c.thread_id,
            nsKey(c.checkpoint_ns ?? ""),
            c.checkpoint_id,
            taskId,
            w.idx,
            taskPath,
            w.channel,
            w.type,
            w.bytes,
          ],
        );
    });
  }

  /**
   * 删除指定图线程的检查点及关联写入。
   *
   * @param threadId thread 对应的唯一标识。
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.db.transaction(async (manager) => {
      await manager.query("DELETE FROM agent_graph_writes WHERE thread_id=?", [
        threadId,
      ]);
      await manager.query(
        "DELETE FROM agent_graph_checkpoints WHERE thread_id=?",
        [threadId],
      );
    });
  }
}
