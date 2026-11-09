// 正引きの索引を public/data/ に置き、Worker の静的アセットとして一緒にデプロイする。
// 静的アセットは丸ごとしか読めないので、dbt の表はパーティションごとに 1 つのファイルにしてあり
// (../dbt_project.yml)、ここではパーティションの値から決まるパスに置く。Worker はパスを組み立てて読む
// (src/assets.ts の assetPath)。
//
// 使い方:
//   node scripts/build-data.mjs                     # FDL のリポジトリ (既定は data.queria.io の company_resolver) の main
//   node scripts/build-data.mjs <リポジトリの URL>
//   node scripts/build-data.mjs --manifest <目録> <出力先>   # 手元のファイル (test/make-fixture.py が使う)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 置く表 (FDL の名前) */
const TABLES = [
  "forward.exact_name",
  "forward.gram",
  "forward.posting_rare",
  "forward.posting_common",
  "forward.city",
  "forward.public_body",
];
/** 静的アセットの 1 ファイルの上限 */
const MAX_BYTES = 25 * 1024 * 1024;
/** 1 回のデプロイに置けるファイルの数の上限 (Workers Paid)。ほかのファイルの分を残す */
const MAX_FILES = 95_000;

/** FDL のパス (「forward/posting_common__dbt_tmp/common_id=3/bucket=17/ducklake-….parquet」) から置き場所 */
const assetPathOf = (table, path) => {
  const values = [...path.matchAll(/(?<=^|\/)[a-z_]+=([^/]+)(?=\/)/g)].map((m) => m[1]);
  return `data/${table.split(".")[1]}${values.map((v) => `/${v}`).join("")}.parquet`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 表ごとのファイル: [{ table, path, bytes, read: () => Promise<Buffer>, copyTo?: string }] */
const fromRepository = async (repo) => {
  const get = async (path, read) => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(repo + path);
        if (!r.ok) throw new Error(`${r.status} ${repo + path}`);
        return await read(r);
      } catch (e) {
        if (i >= 3) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
  };
  const json = (r) => r.json();
  const { data_dir: dataDir = "data/" } = await get("fdl.json", json);
  const id = (await get("refs/heads/main", (r) => r.text())).trim();
  const record = await get(`versions/${id}/version.json`, json);
  const list = await get(`versions/${id}/files.json`, json);
  const files = TABLES.flatMap((table) => {
    const t = list.tables[table];
    if (!t) throw new Error(`${table} is not in version ${id}`);
    if (t.renamed_columns || t.files.some((f) => f.deletes))
      throw new Error(`${table} has deletes or renamed columns`);
    return t.files.map((f) => {
      if (f.path === undefined) throw new Error(`${table} has a file outside the repository`);
      return {
        table,
        path: f.path,
        bytes: f.bytes,
        read: () =>
          get(dataDir + f.path, async (r) => {
            const b = Buffer.from(await r.arrayBuffer());
            if (f.bytes !== undefined && b.length !== f.bytes)
              throw new Error(`size mismatch: ${f.path}`);
            return b;
          }),
      };
    });
  });
  return { version: id, createdAt: record.created_at, files };
};

const fromManifest = async (manifestPath) => {
  const m = JSON.parse(await readFile(manifestPath, "utf8"));
  const root = dirname(manifestPath);
  const files = TABLES.flatMap((table) =>
    (m.tables[table] ?? []).map((path) => ({
      table,
      path,
      read: () => readFile(join(root, path)),
    })),
  );
  return { version: m.version, createdAt: null, files };
};

const args = process.argv.slice(2);
const local = args[0] === "--manifest";
const source = local
  ? await fromManifest(args[1])
  : await fromRepository(
      (args[0] ?? "https://data.queria.io/datasets/queria/company_resolver/").replace(/\/?$/, "/"),
    );
const out = local ? args[2] : fileURLToPath(new URL("../public/", import.meta.url));

const byAsset = new Map();
for (const f of source.files) {
  const asset = assetPathOf(f.table, f.path);
  if (byAsset.has(asset)) throw new Error(`more than one file for ${asset}: ${f.path}`);
  if (f.bytes !== undefined && f.bytes > MAX_BYTES)
    throw new Error(`too large for an asset: ${f.path}`);
  byAsset.set(asset, f);
}
if (byAsset.size > MAX_FILES) throw new Error(`too many files: ${byAsset.size}`);

// 前のビルドのファイルを残さない (前のバージョンにだけあるパーティションを一緒にデプロイしない)
await rm(join(out, "data"), { recursive: true, force: true });
const queue = [...byAsset];
let total = 0;
await Promise.all(
  Array.from({ length: 32 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [asset, f] = item;
      const dest = join(out, asset);
      await mkdir(dirname(dest), { recursive: true });
      const body = await f.read();
      if (body.length > MAX_BYTES) throw new Error(`too large for an asset: ${f.path}`);
      total += body.length;
      await writeFile(dest, body);
    }
  }),
);
// Worker が応答のヘッダー X-Data-Version で返すバージョン (src/assets.ts の loadVersion)
await writeFile(
  join(out, "data", "version.json"),
  JSON.stringify({ version: source.version, created_at: source.createdAt }),
);
console.log(`${source.version}: ${byAsset.size} files, ${(total / 2 ** 20).toFixed(0)} MiB`);
