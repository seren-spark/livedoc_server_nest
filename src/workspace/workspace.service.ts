import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { AccessContext } from "../common/types.js";
import { DatabaseService } from "../database/database.service.js";
import { DocumentsService } from "../documents/documents.service.js";
import type { DocumentRecord } from "../documents/document.types.js";
import { IndexJobsService } from "../indexing/index-jobs.service.js";
import { VectorStoreService } from "../retrieval/vector-store.service.js";
import { DocumentMemoryJobsService } from "../documents/document-memory/document-memory-jobs.service.js";
import { AssetsService } from "../documents/assets/assets.service.js";
import { DocumentMemoryService } from "../documents/document-memory/document-memory.service.js";
import { DocumentImportsService } from "../document-imports/document-imports.service.js";
import { ConversationMemoryService } from "../ai/memory.service.js";
import {
  BUILTIN_TEMPLATES,
  type CategoryState,
  type NoteCategory,
  type NoteTemplate,
} from "./workspace.types.js";

const keyFor = (c: AccessContext) => `${c.space_id}:${c.user_id}`;
const normalizedName = (name: string) =>
  name.trim().normalize("NFKC").toLocaleLowerCase();
export function validateCategoryTree(categories: NoteCategory[]): void {
  const active = categories.filter((c) => !c.deleted_at);
  const byId = new Map(active.map((c) => [c.category_id, c]));
  const names = new Set<string>();
  for (const category of active) {
    if (!category.name.trim() || category.name.trim().length > 100)
      throw new BadRequestException("分类名称必须为 1–100 字符");
    const k = `${category.parent_id ?? ""}:${normalizedName(category.name)}`;
    if (names.has(k))
      throw new ConflictException({
        code: "CATEGORY_NAME_CONFLICT",
        message: "同级分类名称重复",
        category_id: category.category_id,
      });
    names.add(k);
    const visited = new Set([category.category_id]);
    let parent = category.parent_id;
    let depth = 1;
    while (parent) {
      if (visited.has(parent))
        throw new BadRequestException("不能移动到自身或后代");
      visited.add(parent);
      const node = byId.get(parent);
      if (!node) throw new BadRequestException("父分类不存在或已被回收");
      parent = node.parent_id;
      if (++depth > 3) throw new BadRequestException("分类最多三级");
    }
  }
}
export function descendants(categories: NoteCategory[], id: string): string[] {
  const result = new Set([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of categories)
      if (
        c.parent_id &&
        result.has(c.parent_id) &&
        !result.has(c.category_id)
      ) {
        result.add(c.category_id);
        changed = true;
      }
  }
  return [...result];
}
export function backfillCategories(
  state: CategoryState,
  context: AccessContext,
): number {
  let assigned = 0;
  for (const d of state.documents) {
    const first = d.tags.find((tag) => Boolean(tag.trim()));
    if (
      d.category_id ||
      d.deleted_at ||
      !first ||
      ["全部文档", "未分类"].includes(first.trim())
    )
      continue;
    const name = first.trim().slice(0, 100);
    let category = state.categories.find(
      (c) =>
        !c.deleted_at &&
        !c.parent_id &&
        normalizedName(c.name) === normalizedName(name),
    );
    if (!category) {
      category = {
        category_id: randomUUID(),
        space_id: context.space_id,
        owner_id: context.user_id,
        parent_id: null,
        name,
        sort_order: state.categories.length,
        deleted_at: null,
        delete_batch_id: null,
        delete_reason: null,
      };
      state.categories.push(category);
    }
    d.category_id = category.category_id;
    assigned++;
  }
  return assigned;
}

@Injectable()
export class WorkspaceService {
  private readonly trees = new Map<
    string,
    { revision: number; categories: NoteCategory[] }
  >();
  private readonly templates = new Map<string, Map<string, NoteTemplate>>();
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentsService,
    private readonly jobs: IndexJobsService,
    private readonly vectors: VectorStoreService,
    private readonly memoryJobs: DocumentMemoryJobsService,
    private readonly assets: AssetsService,
    private readonly profiles: DocumentMemoryService,
    private readonly memory: ConversationMemoryService,
    private readonly imports: DocumentImportsService,
  ) {}

  async tree(context: AccessContext) {
    const state = await this.load(context);
    return {
      revision: state.revision,
      items: state.categories
        .filter((c) => !c.deleted_at)
        .sort((a, b) => a.sort_order - b.sort_order),
      counts: Object.fromEntries(
        state.categories.map((c) => [
          c.category_id,
          state.documents.filter(
            (d) => !d.deleted_at && d.category_id === c.category_id,
          ).length,
        ]),
      ),
    };
  }
  private async load(
    context: AccessContext,
    manager?: EntityManager,
  ): Promise<CategoryState> {
    const key = keyFor(context);
    if (!this.db.metadataEnabled) {
      const tree = this.trees.get(key) ?? { revision: 0, categories: [] };
      return {
        ...structuredClone(tree),
        documents: structuredClone(await this.documents.ownedPrivate(context)),
      };
    }
    const query = (sql: string, args: unknown[]) =>
      manager ? manager.query(sql, args) : this.db.query<any>(sql, args);
    if (manager)
      await query(
        "INSERT IGNORE INTO note_category_trees(space_id,owner_id,tree_revision) VALUES(?,?,0)",
        [context.space_id, context.user_id],
      );
    const roots = await query(
      `SELECT tree_revision FROM note_category_trees WHERE space_id=? AND owner_id=?${manager ? " FOR UPDATE" : ""}`,
      [context.space_id, context.user_id],
    );
    const categories = await query(
      "SELECT * FROM note_categories WHERE space_id=? AND owner_id=?",
      [context.space_id, context.user_id],
    );
    return {
      revision: Number(roots[0]?.tree_revision ?? 0),
      categories: categories.map((c: any) => ({
        ...c,
        sort_order: Number(c.sort_order),
        deleted_at: c.deleted_at ? new Date(c.deleted_at).toISOString() : null,
      })),
      documents: await this.documents.ownedPrivate(context, manager),
    };
  }
  private async mutate<T>(
    context: AccessContext,
    revision: number,
    work: (state: CategoryState) => T,
  ): Promise<{ result: T; revision: number }> {
    const key = keyFor(context);
    const execute = async (manager?: EntityManager) => {
      const state = await this.load(context, manager);
      if (state.revision !== revision)
        throw new ConflictException({
          code: "CATEGORY_TREE_CONFLICT",
          message: "分类已变更，请刷新后重试",
          revision: state.revision,
        });
      const before = new Map(
        state.documents.map((d) => [d.doc_id, JSON.stringify(d)]),
      );
      const baseVersions = new Map(
        state.documents.map((d) => [d.doc_id, d.document_version]),
      );
      const originalCategoryIds = state.categories.map((c) => c.category_id);
      const result = work(state);
      validateCategoryTree(state.categories);
      state.revision++;
      if (manager) {
        const removed = originalCategoryIds.filter(
          (id) => !state.categories.some((c) => c.category_id === id),
        );
        if (removed.length)
          await manager.query(
            `DELETE FROM note_categories WHERE space_id=? AND owner_id=? AND category_id IN (${removed.map(() => "?").join(",")})`,
            [context.space_id, context.user_id, ...removed],
          );
        for (const c of state.categories)
          await manager.query(
            `INSERT INTO note_categories
          (category_id,space_id,owner_id,parent_id,name,sort_order,deleted_at,delete_batch_id,delete_reason) VALUES(?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id),name=VALUES(name),sort_order=VALUES(sort_order),deleted_at=VALUES(deleted_at),delete_batch_id=VALUES(delete_batch_id),delete_reason=VALUES(delete_reason)`,
            [
              c.category_id,
              c.space_id,
              c.owner_id,
              c.parent_id,
              c.name,
              c.sort_order,
              c.deleted_at ? new Date(c.deleted_at) : null,
              c.delete_batch_id,
              c.delete_reason,
            ],
          );
        for (const d of state.documents)
          if (before.get(d.doc_id) !== JSON.stringify(d))
            await manager.query(
              `UPDATE knowledge_documents SET category_id=?,deleted_at=?,delete_batch_id=?,document_version=?,active_index_version=?,index_status=? WHERE doc_id=?`,
              [
                d.category_id ?? null,
                d.deleted_at ?? null,
                d.delete_batch_id ?? null,
                d.document_version,
                d.active_index_version,
                d.index_status,
                d.doc_id,
              ],
            );
        await manager.query(
          "UPDATE note_category_trees SET tree_revision=? WHERE space_id=? AND owner_id=?",
          [state.revision, context.space_id, context.user_id],
        );
      } else {
        this.trees.set(key, {
          revision: state.revision,
          categories: state.categories,
        });
        this.documents.applyWorkspaceRecords(
          state.documents.filter(
            (d) => before.get(d.doc_id) !== JSON.stringify(d),
          ),
          baseVersions,
        );
      }
      return { result, revision: state.revision };
    };
    if (this.db.metadataEnabled) return this.db.transaction(execute);
    const pending = (this.writes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => execute());
    this.writes.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(key) === pending) this.writes.delete(key);
    }
  }
  private category(state: CategoryState, id: string, deleted = false) {
    const category = state.categories.find(
      (c) => c.category_id === id && (deleted || !c.deleted_at),
    );
    if (!category) throw new NotFoundException("分类不存在");
    return category;
  }
  async create(
    context: AccessContext,
    name: string,
    parent: string | null,
    revision: number,
  ) {
    return this.mutate(context, revision, (s) => {
      if (parent) this.category(s, parent);
      const category: NoteCategory = {
        category_id: randomUUID(),
        space_id: context.space_id,
        owner_id: context.user_id,
        parent_id: parent,
        name: name.trim(),
        sort_order:
          Math.max(
            -1,
            ...s.categories
              .filter((c) => c.parent_id === parent && !c.deleted_at)
              .map((c) => c.sort_order),
          ) + 1,
        deleted_at: null,
        delete_batch_id: null,
        delete_reason: null,
      };
      s.categories.push(category);
      return category;
    });
  }
  async rename(
    context: AccessContext,
    id: string,
    name: string,
    revision: number,
  ) {
    return this.mutate(context, revision, (s) => {
      this.category(s, id).name = name.trim();
      return id;
    });
  }
  async move(
    context: AccessContext,
    id: string,
    parent: string | null,
    revision: number,
    position?: { id: string; after: boolean },
  ) {
    return this.mutate(context, revision, (s) => {
      if (parent) this.category(s, parent);
      const c = this.category(s, id);
      c.parent_id = parent;
      const siblings = s.categories
        .filter(
          (n) =>
            n.parent_id === parent && !n.deleted_at && n.category_id !== id,
        )
        .sort((a, b) => a.sort_order - b.sort_order);
      if (position) {
        const index = siblings.findIndex((n) => n.category_id === position.id);
        if (index < 0)
          throw new BadRequestException("排序目标不是新的同级分类");
        siblings.splice(index + (position.after ? 1 : 0), 0, c);
      } else siblings.push(c);
      siblings.forEach((n, index) => {
        n.sort_order = index;
      });
      return id;
    });
  }
  async reorder(
    context: AccessContext,
    parent: string | null,
    ids: string[],
    revision: number,
  ) {
    return this.mutate(context, revision, (s) => {
      const siblings = s.categories.filter(
        (c) => c.parent_id === parent && !c.deleted_at,
      );
      if (
        ids.length !== siblings.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !siblings.some((c) => c.category_id === id))
      )
        throw new BadRequestException("必须提交完整同级分类顺序");
      ids.forEach((id, i) => {
        this.category(s, id).sort_order = i;
      });
      return ids;
    });
  }
  async assign(
    context: AccessContext,
    ids: string[],
    categoryId: string | null,
    revision: number,
  ) {
    return this.mutate(context, revision, (s) => {
      if (categoryId) this.category(s, categoryId);
      for (const id of ids) {
        const d = s.documents.find((d) => d.doc_id === id && !d.deleted_at);
        if (!d) throw new NotFoundException("私有文档不存在");
        d.category_id = categoryId;
      }
      return ids;
    });
  }
  async merge(
    context: AccessContext,
    source: string,
    target: string,
    revision: number,
  ) {
    return this.mutate(context, revision, (s) => {
      this.category(s, source);
      this.category(s, target);
      if (
        descendants(s.categories, source).includes(target) ||
        descendants(s.categories, target).includes(source)
      )
        throw new BadRequestException("不能合并祖先或后代分类");
      const batch = randomUUID();
      const combine = (from: string, to: string) => {
        for (const d of s.documents)
          if (d.category_id === from) d.category_id = to;
        for (const c of s.categories.filter(
          (c) => !c.deleted_at && c.parent_id === from,
        )) {
          const same = s.categories.find(
            (n) =>
              !n.deleted_at &&
              n.parent_id === to &&
              normalizedName(n.name) === normalizedName(c.name),
          );
          if (same) combine(c.category_id, same.category_id);
          else c.parent_id = to;
        }
        const c = this.category(s, from);
        c.deleted_at = new Date().toISOString();
        c.delete_batch_id = batch;
        c.delete_reason = "merged";
      };
      combine(source, target);
      return { source, target };
    });
  }
  private trashDocument(d: DocumentRecord, batch: string) {
    d.deleted_at = new Date();
    d.delete_batch_id = batch;
    d.document_version++;
    d.active_index_version = null;
  }
  async trashCategory(
    context: AccessContext,
    id: string,
    include: boolean,
    revision: number,
  ) {
    const outcome = await this.mutate(context, revision, (s) => {
      this.category(s, id);
      const ids = descendants(s.categories, id);
      const batch = randomUUID();
      const trashed: string[] = [];
      for (const c of s.categories)
        if (ids.includes(c.category_id) && !c.deleted_at) {
          c.deleted_at = new Date().toISOString();
          c.delete_batch_id = batch;
          c.delete_reason = "user";
        }
      for (const d of s.documents)
        if (!d.deleted_at && d.category_id && ids.includes(d.category_id)) {
          if (include) {
            this.trashDocument(d, batch);
            trashed.push(d.doc_id);
          } else d.category_id = null;
        }
      return { batch, document_ids: trashed };
    });
    await this.suspend(outcome.result.document_ids);
    return outcome;
  }
  async trashDocumentById(context: AccessContext, id: string) {
    const state = await this.load(context);
    const outcome = await this.mutate(context, state.revision, (s) => {
      const d = s.documents.find((d) => d.doc_id === id);
      if (!d) throw new ForbiddenException("只能回收自己的私有知识文档");
      if (!d.deleted_at) this.trashDocument(d, randomUUID());
      return id;
    });
    await this.suspend([id]);
    return outcome;
  }
  async purgeDocuments(
    context: AccessContext,
    ids: string[],
    revision: number,
  ) {
    const execute = async (manager?: EntityManager) => {
      const state = await this.load(context, manager);
      if (state.revision !== revision)
        throw new ConflictException("回收站已变更，请刷新");
      if (
        ids.some(
          (id) => !state.documents.some((d) => d.doc_id === id && d.deleted_at),
        )
      )
        throw new NotFoundException("回收文档不存在");
      // Keep the same tree lock as restore until cleanup and metadata removal finish.
      for (const id of ids) {
        await this.jobs.cancelDocument(id);
        await this.memoryJobs.cancelDocument(id);
        await this.vectors.deleteDocument(id);
        await this.assets.removeWhere({ doc_id: id });
        await this.memory.deleteDocument(id);
        await this.profiles.deleteDocument(id);
        await this.memoryJobs.deleteDocument(id);
        await this.jobs.deleteDocument(id);
        const original = state.documents.find(
          (d) => d.doc_id === id,
        )?.source_import_id;
        if (original) {
          const record = await this.imports.get(original);
          if (
            record?.document_id === id &&
            record.owner_id === context.user_id &&
            record.space_id === context.space_id
          ) {
            await this.imports.remove(original);
            if (await this.imports.get(original))
              await this.imports.remove(original);
          }
        }
      }
      if (manager) {
        await manager.query(
          `DELETE FROM knowledge_documents WHERE doc_id IN (${ids.map(() => "?").join(",")}) AND owner_id=? AND deleted_at IS NOT NULL`,
          [...ids, context.user_id],
        );
        await manager.query(
          "UPDATE note_category_trees SET tree_revision=tree_revision+1 WHERE owner_id=? AND space_id=?",
          [context.user_id, context.space_id],
        );
      } else {
        for (const id of ids) await this.documents.purgeDeleted(id, context);
        this.trees.set(keyFor(context), {
          revision: state.revision + 1,
          categories: state.categories,
        });
      }
      return { status: "purged", ids, revision: state.revision + 1 };
    };
    if (this.db.metadataEnabled) return this.db.transaction(execute);
    const key = keyFor(context);
    const pending = (this.writes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => execute());
    this.writes.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(key) === pending) this.writes.delete(key);
    }
  }
  private async suspend(ids: string[]) {
    for (const id of ids) {
      await this.jobs.cancelDocument(id);
      await this.memoryJobs.cancelDocument(id);
      try {
        await this.vectors.deactivateDocument(id);
      } catch (error) {
        console.error(
          "Vector deactivation pending; SQL deletion filter remains active",
          error,
        );
      }
    }
  }
  async trash(context: AccessContext, type: string) {
    const s = await this.load(context);
    return {
      revision: s.revision,
      items:
        type === "category"
          ? s.categories.filter((c) => c.deleted_at)
          : s.documents.filter((d) => d.deleted_at),
    };
  }
  async restore(
    context: AccessContext,
    type: string,
    ids: string[],
    include: boolean,
    names: Record<string, string>,
    revision: number,
  ) {
    const restored = await this.mutate(context, revision, (s) => {
      const documentIds = new Set<string>();
      const restoreCategory = (id: string) => {
        const c = this.category(s, id, true);
        if (c.parent_id) restoreCategory(c.parent_id);
        if (c.deleted_at)
          c.sort_order =
            Math.max(
              -1,
              ...s.categories
                .filter(
                  (n) =>
                    n.category_id !== id &&
                    n.parent_id === c.parent_id &&
                    !n.deleted_at,
                )
                .map((n) => n.sort_order),
            ) + 1;
        c.deleted_at = null;
        if (names[id]) c.name = names[id]!.trim();
      };
      for (const id of ids)
        if (type === "category") {
          const selected = this.category(s, id, true);
          const batch = selected.delete_batch_id;
          const sub = descendants(s.categories, id);
          restoreCategory(id);
          for (const c of s.categories)
            if (
              sub.includes(c.category_id) &&
              c.deleted_at &&
              c.delete_batch_id === batch
            )
              restoreCategory(c.category_id);
          if (include)
            for (const d of s.documents)
              if (
                d.deleted_at &&
                d.delete_batch_id === batch &&
                d.category_id &&
                sub.includes(d.category_id)
              )
                documentIds.add(d.doc_id);
        } else {
          const d = s.documents.find((d) => d.doc_id === id && d.deleted_at);
          if (!d) throw new NotFoundException("回收文档不存在");
          documentIds.add(id);
        }
      for (const id of documentIds) {
        const d = s.documents.find((d) => d.doc_id === id)!;
        if (d.category_id) {
          if (s.categories.some((c) => c.category_id === d.category_id))
            restoreCategory(d.category_id);
          else d.category_id = null;
        }
        d.deleted_at = null;
        d.delete_batch_id = null;
        d.document_version++;
        d.active_index_version = null;
        d.index_status = "pending";
      }
      return { document_ids: [...documentIds] };
    });
    for (const id of restored.result.document_ids) {
      const d = await this.documents.require(id);
      await this.memoryJobs.enqueue(d, context);
      if (d.indexed_at) {
        const { toIndexRequest } = await import(
          "../documents/document.types.js"
        );
        const job = await this.jobs.enqueue(toIndexRequest(d), context);
        await this.documents.markQueued(id, job.job_id);
      }
    }
    return restored;
  }
  async purgeCategories(
    context: AccessContext,
    ids: string[],
    revision: number,
  ) {
    const remove = new Set<string>();
    const outcome = await this.mutate(context, revision, (s) => {
      for (const id of ids) {
        const c = this.category(s, id, true);
        if (!c.deleted_at)
          throw new BadRequestException("先回收分类再彻底删除");
        descendants(s.categories, id).forEach((n) => remove.add(n));
      }
      if (s.categories.some((c) => remove.has(c.category_id) && !c.deleted_at))
        throw new BadRequestException("不能彻底删除存活子分类");
      for (const d of s.documents)
        if (d.category_id && remove.has(d.category_id)) d.category_id = null;
      s.categories = s.categories.filter((c) => !remove.has(c.category_id));
      return [...remove];
    });
    return outcome;
  }
  async listTemplates(context: AccessContext): Promise<NoteTemplate[]> {
    const rows = this.db.metadataEnabled
      ? await this.db.query<any>(
          "SELECT * FROM note_templates WHERE owner_id=? AND space_id=? ORDER BY name",
          [context.user_id, context.space_id],
        )
      : [...(this.templates.get(keyFor(context))?.values() ?? [])];
    return [
      ...BUILTIN_TEMPLATES,
      ...rows.map((r: any) => ({ ...r, revision: Number(r.revision) })),
    ];
  }
  async getTemplate(context: AccessContext, id: string) {
    const t = (await this.listTemplates(context)).find(
      (t) => t.template_id === id,
    );
    if (!t) throw new NotFoundException("模板不存在");
    return t;
  }
  async saveTemplate(
    context: AccessContext,
    input: Partial<NoteTemplate>,
    id?: string,
    revision?: number,
  ) {
    if (id?.startsWith("builtin-"))
      throw new ForbiddenException("内置模板只读，请复制");
    const existing = id ? await this.getTemplate(context, id) : null;
    if (existing && existing.revision !== revision)
      throw new ConflictException("模板已变更");
    const t: NoteTemplate = {
      template_id: id ?? randomUUID(),
      name: (input.name ?? existing?.name ?? "").trim(),
      description: input.description ?? existing?.description ?? "",
      markdown: input.markdown ?? existing?.markdown ?? "",
      instructions: input.instructions ?? existing?.instructions ?? "",
      revision: (existing?.revision ?? 0) + 1,
    };
    if (!t.name || t.name.length > 100 || t.markdown.length > 100000)
      throw new BadRequestException("模板名称或内容长度无效");
    if (this.db.metadataEnabled) {
      if (existing) {
        const result: any = await this.db.source.query(
          "UPDATE note_templates SET name=?,description=?,markdown=?,instructions=?,revision=? WHERE template_id=? AND owner_id=? AND revision=?",
          [
            t.name,
            t.description,
            t.markdown,
            t.instructions,
            t.revision,
            t.template_id,
            context.user_id,
            revision,
          ],
        );
        if (!result.affectedRows) throw new ConflictException("模板已变更");
      } else
        await this.db.query(
          "INSERT INTO note_templates(template_id,space_id,owner_id,name,description,markdown,instructions,revision) VALUES(?,?,?,?,?,?,?,?)",
          [
            t.template_id,
            context.space_id,
            context.user_id,
            t.name,
            t.description,
            t.markdown,
            t.instructions,
            t.revision,
          ],
        );
    } else {
      const map = this.templates.get(keyFor(context)) ?? new Map();
      map.set(t.template_id, t);
      this.templates.set(keyFor(context), map);
    }
    return t;
  }
  async deleteTemplate(context: AccessContext, id: string) {
    if (id.startsWith("builtin-")) throw new ForbiddenException("内置模板只读");
    await this.getTemplate(context, id);
    if (this.db.metadataEnabled)
      await this.db.query(
        "DELETE FROM note_templates WHERE template_id=? AND owner_id=? AND space_id=?",
        [id, context.user_id, context.space_id],
      );
    else this.templates.get(keyFor(context))?.delete(id);
    return { status: "deleted" };
  }
  async backfill(context: AccessContext) {
    const s = await this.load(context);
    return this.mutate(context, s.revision, (state) =>
      backfillCategories(state, context),
    );
  }
}
