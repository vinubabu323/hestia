import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

export async function runMigrations(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const dir = path.join(import.meta.dirname, "migrations");
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const rows = await sql`SELECT name FROM _migrations WHERE name = ${file}`;
    if (rows.length > 0) continue;

    const content = await readFile(path.join(dir, file), "utf8");
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    console.log(`migration: applied ${file}`);
  }
}
