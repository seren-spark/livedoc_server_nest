import { AppConfig } from "../src/config/app-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { mapDocumentRow } from "../src/documents/documents.repository.js";
import {
  backfillCategories,
  validateCategoryTree,
} from "../src/workspace/workspace.service.js";
const config = new AppConfig();
const db = new DatabaseService(config);
if (!db.metadataEnabled) throw new Error("分类回填需要 METADATA_STORE=mysql");
await db.onModuleInit();
try {
  const owners = await db.query<{ owner_id: string; space_id: string }>(
    "SELECT DISTINCT owner_id,space_id FROM knowledge_documents WHERE visibility='private' AND owner_id IS NOT NULL AND deleted_at IS NULL",
  );
  let assigned = 0;
  for (const owner of owners)
    assigned += await db.transaction(async (manager) => {
      const context = {
        user_id: owner.owner_id,
        space_id: owner.space_id,
        team_ids: [],
      };
      await manager.query(
        "INSERT IGNORE INTO note_category_trees(space_id,owner_id,tree_revision) VALUES(?,?,0)",
        [owner.space_id, owner.owner_id],
      );
      const roots = await manager.query(
        "SELECT tree_revision FROM note_category_trees WHERE space_id=? AND owner_id=? FOR UPDATE",
        [owner.space_id, owner.owner_id],
      );
      const categories = await manager.query(
        "SELECT * FROM note_categories WHERE space_id=? AND owner_id=?",
        [owner.space_id, owner.owner_id],
      );
      const rows = await manager.query(
        "SELECT * FROM knowledge_documents d WHERE visibility='private' AND owner_id=? AND space_id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM article_drafts a WHERE a.article_id=d.doc_id) FOR UPDATE",
        [owner.owner_id, owner.space_id],
      );
      const state = {
        revision: Number(roots[0].tree_revision),
        categories,
        documents: rows.map(mapDocumentRow),
      };
      const originals = new Set(categories.map((c: any) => c.category_id));
      const changed = backfillCategories(state, context);
      validateCategoryTree(state.categories);
      for (const c of state.categories)
        if (!originals.has(c.category_id))
          await manager.query(
            "INSERT INTO note_categories(category_id,space_id,owner_id,parent_id,name,sort_order) VALUES(?,?,?,?,?,?)",
            [
              c.category_id,
              c.space_id,
              c.owner_id,
              c.parent_id,
              c.name,
              c.sort_order,
            ],
          );
      for (const d of state.documents)
        if (d.category_id)
          await manager.query(
            "UPDATE knowledge_documents SET category_id=? WHERE doc_id=? AND category_id IS NULL",
            [d.category_id, d.doc_id],
          );
      if (changed)
        await manager.query(
          "UPDATE note_category_trees SET tree_revision=tree_revision+1 WHERE space_id=? AND owner_id=?",
          [owner.space_id, owner.owner_id],
        );
      return changed;
    });
  console.log(
    JSON.stringify({ status: "ok", owners: owners.length, assigned }),
  );
} finally {
  await db.onModuleDestroy();
}
