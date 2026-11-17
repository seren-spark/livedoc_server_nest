/**
 * @file Wiki 知识存储。读写知识页面、来源关系与状态转换，查询关联候选。
 */
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import type { AccessContext } from "../common/types.js";
import type { WikiPage, WikiProof } from "./wiki.types.js";

@Injectable()
export class WikiRepository {
  private readonly pages = new Map<string, WikiPage>();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param db 共享数据库服务。
   */
  constructor(private readonly db: DatabaseService) {}
  /**
   * 将数据库 Wiki 行的 JSON 与时间字段还原为业务对象。
   *
   * @param row 数据库查询返回的一行数据。
   * @returns Wiki 知识页面。
   */
  private map(row: any): WikiPage {
    return {
      ...row,
      payload:
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
  /**
   * 按查询条件读取Wiki 知识页列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面列表。
   */
  async list(context: AccessContext): Promise<WikiPage[]> {
    // ponytail: the personal MVP searches the latest 100 pages; paginate candidate
    // discovery before expanding beyond this explicitly documented limit.
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        "SELECT * FROM wiki_pages WHERE space_id=? AND owner_id=? AND status<>'archived' ORDER BY updated_at DESC LIMIT 100",
        [context.space_id, context.user_id],
      );
      return rows.map((row) => this.map(row));
    }
    return [...this.pages.values()]
      .filter(
        (page) =>
          page.space_id === context.space_id &&
          page.owner_id === context.user_id &&
          page.status !== "archived",
      )
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, 100)
      .map((page) => structuredClone(page));
  }
  /**
   * 按标识读取Wiki 知识页。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面；未找到或不可用时可能为空。
   */
  async get(id: string, context: AccessContext): Promise<WikiPage | undefined> {
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        "SELECT * FROM wiki_pages WHERE wiki_id=? AND space_id=? AND owner_id=?",
        [id, context.space_id, context.user_id],
      );
      return rows[0] ? this.map(rows[0]) : undefined;
    }
    const page = this.pages.get(id);
    return page?.space_id === context.space_id &&
      page.owner_id === context.user_id
      ? structuredClone(page)
      : undefined;
  }
  /**
   * 按标识集合批量读取当前用户可访问的 Wiki 页面。
   *
   * @param ids 本次操作涉及的记录标识集合。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面列表。
   */
  async getMany(ids: string[], context: AccessContext): Promise<WikiPage[]> {
    if (!ids.length) return [];
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        `SELECT * FROM wiki_pages WHERE space_id=? AND owner_id=? AND wiki_id IN (${ids.map(() => "?").join(",")})`,
        [context.space_id, context.user_id, ...ids],
      );
      return rows.map(row => this.map(row));
    }
    return [...this.pages.values()].filter(page => ids.includes(page.wiki_id) &&
      page.space_id === context.space_id && page.owner_id === context.user_id).map(page => structuredClone(page));
  }

  /**
   * 查询当前知识页的后续版本或替代页面。
   *
   * @param proofs 引用来源读取时保存的身份与版本证明。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面列表。
   */
  async successors(proofs: WikiProof[], context: AccessContext): Promise<WikiPage[]> {
    if (!proofs.length) return [];
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        `SELECT * FROM wiki_pages WHERE space_id=? AND owner_id=? AND status='published'
         AND (${proofs.map(() => "JSON_CONTAINS(payload, ?, '$.supersedes')").join(" OR ")})`,
        [context.space_id, context.user_id, ...proofs.map(proof => JSON.stringify(proof))],
      );
      return rows.map(row => this.map(row));
    }
    return [...this.pages.values()].filter(page => page.space_id === context.space_id &&
      page.owner_id === context.user_id && page.status === "published" && proofs.some(proof =>
        page.payload.supersedes?.wiki_id === proof.wiki_id && page.payload.supersedes.revision === proof.revision))
      .map(page => structuredClone(page));
  }

  /**
   * 按知识沉淀摘要查找已存在的候选，避免重复编译。
   *
   * @param hash 待核对的内容摘要。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面；未找到或不可用时可能为空。
   */
  async byCaptureHash(hash: string, context: AccessContext): Promise<WikiPage | undefined> {
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        "SELECT * FROM wiki_pages WHERE space_id=? AND owner_id=? AND status='published' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.capture_hash'))=? ORDER BY updated_at DESC LIMIT 1",
        [context.space_id, context.user_id, hash],
      );
      return rows[0] ? this.map(rows[0]) : undefined;
    }
    const page = [...this.pages.values()].find(page => page.space_id === context.space_id &&
      page.owner_id === context.user_id && page.status === "published" && page.payload.capture_hash === hash);
    return page ? structuredClone(page) : undefined;
  }
  /**
   * 查询引用指定来源的关联知识页面。
   *
   * @param proofs 引用来源读取时保存的身份与版本证明。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面列表。
   */
  async dependents(proofs: WikiProof[], context: AccessContext): Promise<WikiPage[]> {
    if (!proofs.length) return [];
    // Parents include the transitive closure, so withdrawal is not limited by list()'s window.
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        `SELECT * FROM wiki_pages WHERE space_id=? AND owner_id=? AND status<>'archived'
         AND (${proofs.map(() => "JSON_CONTAINS(payload, ?, '$.parents')").join(" OR ")})`,
        [context.space_id, context.user_id, ...proofs.map(proof => JSON.stringify(proof))],
      );
      return rows.map(row => this.map(row));
    }
    return [...this.pages.values()].filter(page =>
      page.space_id === context.space_id && page.owner_id === context.user_id && page.status !== "archived" &&
      page.payload.parents?.some(parent => proofs.some(proof =>
        proof.wiki_id === parent.wiki_id && proof.revision === parent.revision)),
    ).map(page => structuredClone(page));
  }
  /**
   * 查询指定 Agent 运行生成的知识候选。
   *
   * @param runId run 对应的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Wiki 知识页面；未找到或不可用时可能为空。
   */
  async byRun(
    runId: string,
    context: AccessContext,
  ): Promise<WikiPage | undefined> {
    if (this.db.metadataEnabled) {
      const rows = await this.db.query(
        "SELECT * FROM wiki_pages WHERE origin_run_id=? AND space_id=? AND owner_id=?",
        [runId, context.space_id, context.user_id],
      );
      return rows[0] ? this.map(rows[0]) : undefined;
    }
    return [...this.pages.values()]
      .filter(
        (page) =>
          page.origin_run_id === runId &&
          page.owner_id === context.user_id &&
          page.space_id === context.space_id,
      )
      .map((page) => structuredClone(page))[0];
  }
  /**
   * 向存储写入新的Wiki 知识页。
   *
   * @param page 当前页码或页面记录。
   * @returns Wiki 知识页面。
   */
  async insert(page: WikiPage): Promise<WikiPage> {
    const context = {
      space_id: page.space_id,
      user_id: page.owner_id,
      team_ids: [],
    };
    if (this.db.metadataEnabled) {
      try {
        await this.db.query(
          "INSERT INTO wiki_pages(wiki_id,space_id,owner_id,origin_run_id,revision,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            page.wiki_id,
            page.space_id,
            page.owner_id,
            page.origin_run_id,
            page.revision,
            page.status,
            JSON.stringify(page.payload),
            page.created_at,
            page.updated_at,
          ],
        );
      } catch (error: any) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        const existing = await this.byRun(page.origin_run_id, context);
        if (!existing) throw error;
        return existing;
      }
    } else {
      const existing = [...this.pages.values()].find(
        (item) =>
          item.origin_run_id === page.origin_run_id &&
          item.space_id === page.space_id &&
          item.owner_id === page.owner_id,
      );
      if (existing) return structuredClone(existing);
      this.pages.set(page.wiki_id, structuredClone(page));
    }
    return page;
  }
  /**
   * 以预期状态为条件更新知识页状态。
   *
   * @param page 当前页码或页面记录。
   * @param from 编辑区间的起始位置。
   * @param status 本次需要记录或切换到的状态。
   * @param error 本次操作捕获的异常（可选）。
   * @returns 条件是否满足的判断结果。
   */
  async transition(
    page: WikiPage,
    from: WikiPage["status"][],
    status: WikiPage["status"],
    error?: string,
  ) {
    const payload = { ...page.payload, error };
    const now = new Date();
    if (this.db.metadataEnabled) {
      const result = await this.db.source.query(
        `UPDATE wiki_pages SET status=?,payload=?,updated_at=? WHERE wiki_id=? AND space_id=? AND owner_id=? AND revision=? AND status IN (${from.map(() => "?").join(",")})`,
        [
          status,
          JSON.stringify(payload),
          now,
          page.wiki_id,
          page.space_id,
          page.owner_id,
          page.revision,
          ...from,
        ],
      );
      return Number(result.affectedRows) === 1;
    }
    const current = this.pages.get(page.wiki_id);
    if (
      !current ||
      current.space_id !== page.space_id ||
      current.owner_id !== page.owner_id ||
      current.revision !== page.revision ||
      !from.includes(current.status)
    )
      return false;
    this.pages.set(page.wiki_id, {
      ...current,
      status,
      payload: structuredClone(payload),
      updated_at: now,
    });
    return true;
  }

  /**
   * 更新知识页附加的诊断、反馈或关联信息。
   *
   * @param page 当前页码或页面记录。
   * @param field 当前读取或校验的字段名。
   * @param value 待校验或转换的值。
   * @returns 条件是否满足的判断结果。
   */
  async annotate(page: WikiPage, field: "user_feedback" | "conflicted_by_run", value: string): Promise<boolean> {
    const now = new Date();
    if (this.db.metadataEnabled) {
      const result = await this.db.source.query(
        "UPDATE wiki_pages SET payload=JSON_SET(payload,?,?),updated_at=? WHERE wiki_id=? AND space_id=? AND owner_id=? AND revision=? AND status=?",
        [`$.${field}`, value, now, page.wiki_id, page.space_id, page.owner_id, page.revision, page.status],
      );
      return Number(result.affectedRows) === 1;
    }
    const current = this.pages.get(page.wiki_id);
    if (!current || current.space_id !== page.space_id || current.owner_id !== page.owner_id ||
        current.revision !== page.revision || current.status !== page.status) return false;
    this.pages.set(page.wiki_id, { ...current, updated_at: now, payload: { ...current.payload, [field]: value } });
    return true;
  }
}
