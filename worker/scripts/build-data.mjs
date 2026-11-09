// 正引きの索引を public/data/ に置き、Worker の静的アセットとして一緒にデプロイする。
// 静的アセットは丸ごとしか読めないので、dbt の表 (分けずに書いてある) を DuckDB で読み、shard などの列で
// ファイルに分ける。置き場所は列の値で決まり (data/posting_common/{common_id}/{bucket}.parquet など)、
// Worker はパスを組み立てて読む (src/forward.ts)。
//
// 使い方:
//   node scripts/build-data.mjs                         # FDL のリポジトリ (既定は data.queria.io の company_resolver) の main
//   node scripts/build-data.mjs <リポジトリの URL>
//   node scripts/build-data.mjs --catalog <ATTACH する DuckLake> <出力先>   # 手元のカタログ (test/make-fixture.py)
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";

/** 表と、ファイルを分ける列 (並べる列)。分けない表は 1 つのファイル */
const TABLES = [
  { name: "exact_name", by: ["shard"], order: "shard, core, lg_code, corporate_number" },
  { name: "gram", by: ["shard"], order: "shard, g" },
  { name: "posting_rare", by: ["shard"], order: "shard, g, lg_code, corporate_number" },
  {
    name: "posting_common",
    by: ["common_id", "bucket"],
    order: "common_id, bucket, lg_code, corporate_number",
  },
  { name: "city", by: [], order: "lg_code" },
];
/** 静的アセットの 1 ファイルの上限 */
const MAX_BYTES = 25 * 1024 * 1024;
/** 1 回のデプロイに置けるファイルの数の上限 (Workers Paid)。ほかのファイルの分を残す */
const MAX_FILES = 95_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** FDL のリポジトリの main が指すバージョンの、ATTACH するカタログとバージョン */
const fromRepository = async (repo) => {
  const get = async (path) => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(repo + path);
        if (!r.ok) throw new Error(`${r.status} ${repo + path}`);
        return await r.text();
      } catch (e) {
        if (i >= 3) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
  };
  const id = (await get("refs/heads/main")).trim();
  const record = JSON.parse(await get(`versions/${id}/version.json`));
  return {
    catalog: `ducklake:${repo}versions/${id}/ducklake.duckdb`,
    version: id,
    createdAt: record.created_at,
  };
};

const args = process.argv.slice(2);
const local = args[0] === "--catalog";
const source = local
  ? { catalog: args[1], version: "local", createdAt: null }
  : await fromRepository(
      (args[0] ?? "https://data.queria.io/datasets/queria/company_resolver/").replace(/\/?$/, "/"),
    );
const out = join(local ? args[2] : fileURLToPath(new URL("../public/", import.meta.url)), "data");

const db = await DuckDBInstance.create(":memory:");
const con = await db.connect();
// 1 スレッドで、並べた順のまま書く (分けた先のファイルを 1 つにする)
await con.run("INSTALL ducklake; LOAD ducklake; INSTALL httpfs; LOAD httpfs; SET threads = 1");
await con.run(`ATTACH '${source.catalog.replaceAll("'", "''")}' AS c (READ_ONLY)`);

// 前のビルドのファイルを残さない (前のバージョンにだけあるファイルを一緒にデプロイしない)
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/** 「列=値」のディレクトリを「値」にし、中のファイル (1 つだけのはず) を「値.parquet」にする */
const flatten = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const value = entry.name.slice(entry.name.indexOf("=") + 1);
    const children = await readdir(path, { withFileTypes: true });
    if (children.some((c) => c.isDirectory())) {
      await flatten(path);
      await rename(path, join(dir, value));
      continue;
    }
    if (children.length !== 1) throw new Error(`${children.length} files in ${path}`);
    await rename(join(path, children[0].name), join(dir, `${value}.parquet`));
    await rmdir(path);
  }
};

for (const t of TABLES) {
  const query = `SELECT * FROM c.forward.${t.name} ORDER BY ${t.order}`;
  if (t.by.length === 0) {
    await con.run(
      `COPY (${query}) TO '${join(out, `${t.name}.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`,
    );
    continue;
  }
  const dir = join(out, t.name);
  await con.run(
    `COPY (${query}) TO '${dir}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (${t.by.join(", ")}), FILENAME_PATTERN 'part')`,
  );
  await flatten(dir);
}

// ファイルの数と大きさを確かめる
let count = 0;
let total = 0;
for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const { size } = await stat(join(entry.parentPath, entry.name));
  if (size > MAX_BYTES) throw new Error(`too large for an asset: ${entry.name}`);
  count += 1;
  total += size;
}
if (count > MAX_FILES) throw new Error(`too many files: ${count}`);

// Worker が応答のヘッダー X-Data-Version で返すバージョン (src/assets.ts の loadVersion)
await writeFile(
  join(out, "version.json"),
  JSON.stringify({ version: source.version, created_at: source.createdAt }),
);
console.log(`${source.version}: ${count} files, ${(total / 2 ** 20).toFixed(0)} MiB`);
