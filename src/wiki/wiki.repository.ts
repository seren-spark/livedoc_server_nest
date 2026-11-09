import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import type { AccessContext } from "../common/types.js";
import type { WikiPage, WikiProof } from "./wiki.types.js";

@Injectable()
export class WikiRepository {
  private readonly pages = new Map<string, WikiPage>();
  constructor(private readonly db: DatabaseService) {}
  private map(row: any): WikiPage {
    return {
      ...row,
      payload:
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
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
