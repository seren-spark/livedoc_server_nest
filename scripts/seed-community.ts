import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AppConfig } from "../src/config/app-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { hashPassword } from "../src/auth/auth.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { ArticleRepository } from "../src/articles/article.repository.js";
import { ArticlesService } from "../src/articles/articles.service.js";
import { ArticleInteractionsRepository } from "../src/articles/article-interactions.repository.js";

const slug = z.string().regex(/^[a-z0-9-]{2,36}$/);
const manifest = z.object({
  users: z.array(z.object({ slug, name: z.string().min(2), focus: z.string().min(2) })).min(20),
  articles: z.array(z.object({ slug, author: slug, title: z.string().min(10).max(120),
    summary: z.string().min(50).max(300), tags: z.array(z.string().min(1).max(20)).min(2).max(5),
    question: z.string().min(20), reply: z.string().min(30), discussion: z.string().min(30),
  })).min(24),
}).parse(JSON.parse(await readFile(new URL("./community/manifest.json", import.meta.url), "utf8")));
assert.equal(new Set(manifest.users.map(item => item.slug)).size, manifest.users.length);
assert.equal(new Set(manifest.articles.map(item => item.slug)).size, manifest.articles.length);
const articles = await Promise.all(manifest.articles.map(async item => {
  assert(manifest.users.some(user => user.slug === item.author), `未知作者：${item.author}`);
  const content = await readFile(new URL(`./community/${item.slug}.md`, import.meta.url), "utf8");
  const han = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  assert(han >= 900 && content.trim().length >= 1400, `正文过短：${item.slug}（中文 ${han} 字）`);
  assert((content.match(/^## /gm)?.length ?? 0) >= 4, `缺少完整章节：${item.slug}`);
  return { ...item, content, han, id: `community_v1_${item.slug}` };
}));
const validation = { users: manifest.users.length, articles: articles.length,
  min_chinese_characters: Math.min(...articles.map(item => item.han)),
  max_chinese_characters: Math.max(...articles.map(item => item.han)),
  average_chinese_characters: Math.round(articles.reduce((sum, item) => sum + item.han, 0) / articles.length) };
console.log(JSON.stringify({ corpus: validation }));
if (!process.argv.includes("--apply") && !process.argv.includes("--verify")) {
  console.log("题材与正文校验完成。--apply 写入新演示数据；--verify 只复核数据库中的已有演示数据。");
} else {
  const config = new AppConfig();
  assert.equal(config.metadataStore, "mysql", "需要当前应用配置的 MySQL，不能只写到进程内存");
  const database = new DatabaseService(config);
  const prefix = "community_v1_";
  const userId = (name: string) => `community_user_${name}`;
  const created = { users: 0, articles: 0, comments: 0, reactions: 0 };
  try {
    await database.onModuleInit();
    if (process.argv.includes("--apply")) {
      const passwordHash = hashPassword("Demo@123456");
      await database.transaction(async manager => {
        for (const user of manifest.users) {
          const email = `${user.slug}@community.livedoc.local`;
          const existing = await manager.query("SELECT user_id,email FROM demo_users WHERE user_id=? OR email=?", [userId(user.slug), email]);
          if (existing.length) {
            assert(existing.length === 1 && existing[0].user_id === userId(user.slug) && existing[0].email === email, "演示用户标识与已有账户冲突");
            continue;
          }
          await manager.query("INSERT INTO demo_users (user_id,username,email,password_hash,space_id,is_active) VALUES (?,?,?,?,?,TRUE)",
            [userId(user.slug), user.name, email, passwordHash, "space_a"]);
          created.users++;
        }
        for (const [index, article] of articles.entries()) {
          const existing = await manager.query("SELECT owner_id FROM article_drafts WHERE article_id=?", [article.id]);
          if (existing.length) {
            assert.equal(existing[0].owner_id, userId(article.author), "演示文章标识与其他作者冲突");
            continue; // Never overwrite an existing article, including later edits/withdrawal.
          }
          assert.equal((await manager.query("SELECT doc_id FROM knowledge_documents WHERE doc_id=?", [article.id])).length, 0);
          const publishedAt = new Date(Date.now() - (index * 37 + 3) * 3600000);
          const draft = { title: article.title, content: article.content, editor_content: null, summary: article.summary,
            tags: article.tags, cover_asset_id: null, asset_ids: [] };
          await manager.query(`INSERT INTO article_drafts
            (article_id,space_id,owner_id,state,draft_version,draft,published_draft_version,published_metadata,published_at,last_published_at,created_at,updated_at)
            VALUES (?,?,?,'published',1,?,1,?,?,?,?,?)`,
          [article.id, "space_a", userId(article.author), JSON.stringify(draft),
            JSON.stringify({ summary: article.summary, cover_asset_id: null, asset_ids: [], include_in_knowledge: false }),
            publishedAt, publishedAt, publishedAt, publishedAt]);
          await manager.query(`INSERT INTO knowledge_documents
            (doc_id,space_id,title,content,visibility,source_type,tags,owner_id,url,document_version,index_status,chunk_count,created_at,updated_at)
            VALUES (?,?,?,?,'public','public_article',?,?,?,1,'pending',0,?,?)`,
          [article.id, "space_a", article.title, article.content, JSON.stringify(article.tags), userId(article.author), `/post/${article.id}`, publishedAt, publishedAt]);
          created.articles++;
          const readers = manifest.users.filter(user => user.slug !== article.author);
          const comments = [
            { id: `${article.id}_question`, parent: null, user: readers[index % readers.length]!, text: article.question },
            { id: `${article.id}_reply`, parent: `${article.id}_question`, user: manifest.users.find(user => user.slug === article.author)!, text: article.reply },
            { id: `${article.id}_discussion`, parent: null, user: readers[(index + 7) % readers.length]!, text: article.discussion },
          ];
          for (const [position, comment] of comments.entries()) {
            await manager.query("INSERT INTO article_comments (comment_id,article_id,user_id,content,created_at,parent_comment_id) VALUES (?,?,?,?,?,?)",
              [comment.id, article.id, userId(comment.user.slug), comment.text, new Date(publishedAt.getTime() + (position + 1) * 1800000), comment.parent]);
            created.comments++;
          }
          for (const [position, reader] of readers.entries()) {
            const kinds = [ ...(position < 4 + index % 9 ? ["like"] : []), ...(position % 4 === index % 4 ? ["favorite"] : []) ];
            for (const kind of kinds) {
              await manager.query("INSERT INTO article_reactions (article_id,user_id,kind,created_at) VALUES (?,?,?,?)",
                [article.id, userId(reader.slug), kind, new Date(publishedAt.getTime() + (position + 1) * 60000)]);
              created.reactions++;
            }
          }
        }
      });
    }
    // Read through the same services used by public list/detail routes, on the real database.
    const repository = new ArticleRepository(database);
    const interactions = new ArticleInteractionsRepository(database);
    const documents = new DocumentsService(database, repository, interactions);
    const publications = new ArticlesService(repository, documents, null!, null!, null!, config, interactions);
    const verified = [];
    for (const article of articles) {
      const record = await publications.publicRecord(await documents.getPublicArticle(article.id));
      const draft = await repository.get(article.id);
      assert(draft?.published_metadata?.include_in_knowledge === false, "演示文章不应自动进入知识库索引");
      assert(record.author_name && !record.author_name.startsWith("community_user_"));
      assert.equal(record.content, draft.draft.content);
      verified.push({ id: record.doc_id, title: record.title, author: record.author_name,
        chinese_characters: record.content.match(/\p{Script=Han}/gu)?.length ?? 0,
        likes: record.like_count, favorites: record.favorite_count, comments: record.comment_count });
    }
    let visible = 0;
    for (let page = 1; ; page++) {
      const feed = await documents.listPublicArticles(page, 8);
      visible += feed.items.filter(item => item.doc_id.startsWith(prefix)).length;
      if (page * 8 >= feed.total) break;
    }
    assert.equal(visible, articles.length, "演示文章未全部出现在公开分页列表");
    const report = { checked_at: new Date().toISOString(), corpus: validation, created,
      public_articles: visible, accounts: manifest.users.map(user => ({ name: user.name, email: `${user.slug}@community.livedoc.local`, focus: user.focus })),
      articles: verified };
    const output = resolve(config.projectRoot, "data/seeding/community-latest.json");
    await mkdir(resolve(config.projectRoot, "data/seeding"), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ created, public_articles: visible, report: output }));
  } finally { await database.onModuleDestroy(); }
}
