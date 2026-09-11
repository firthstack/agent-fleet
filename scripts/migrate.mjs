// 按文件名顺序重放 migrations/*.sql，记录在 schema_migrations 表里。
//
// 用法（DATABASE_URL 由 insta 注入，不落盘）：
//   insta run -- node scripts/migrate.mjs
//   insta run --branch <b> -- node scripts/migrate.mjs
//   node scripts/migrate.mjs --dry-run     # 只列出待执行的
//
// 每个文件在单个事务里执行：要么整文件生效，要么整文件回滚。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "migrations";
const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run via: insta run -- node scripts/migrate.mjs");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: /\bsslmode=disable\b/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
});

await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query("SELECT filename FROM schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`up to date (${files.length} migration(s) already applied)`);
    process.exit(0);
  }

  if (dryRun) {
    console.log("pending:");
    for (const f of pending) console.log(`  ${f}`);
    process.exit(0);
  }

  for (const filename of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    process.stdout.write(`applying ${filename} … `);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      await client.query("COMMIT");
      console.log("ok");
    } catch (err) {
      await client.query("ROLLBACK");
      console.log("FAILED");
      console.error(`\n${filename}:\n${err.message}`);
      process.exit(1);
    }
  }

  console.log(`applied ${pending.length} migration(s)`);
} finally {
  await client.end();
}
