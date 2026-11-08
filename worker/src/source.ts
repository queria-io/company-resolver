// 索引のファイルの置き場を引く。Worker が知るのは置き場 (DATA_SOURCE) だけにする。
//   - 「…/」: FDL のリポジトリ (Queria の company_resolver データセット)。refs/heads/main が指すバージョンの
//     files.json (テーブルごとのファイル一覧) から引く。毎月の Sync で main が進めば、デプロイなしで読む先が切り替わる
//   - 「….json」: 目録。{ "version": "…", "tables": { "forward.posting": ["forward/posting/shard=1/a.parquet"], … } }。
//     パスは目録からの相対。テストと、セルフホストで自分の Parquet を読ませるときに使う

/** Worker が読むテーブル (スキーマ.テーブル)。dbt のモデル (models/) と同じ名前 */
export const TABLES = [
  "forward.posting",
  "forward.gram",
  "forward.city",
  "reverse.company",
] as const;
export type Table = (typeof TABLES)[number];

/** R2 のキーと、分かればファイルの大きさとフッターの長さ */
export type FileRef = { key: string; bytes?: number; footer?: number };
export type Index = { version: string; tables: Record<Table, FileRef[]> };

type Manifest = { version: string; tables: Partial<Record<Table, string[]>> };
/** FDL の versions/<ID>/files.json */
type FileList = {
  tables: Record<
    string,
    {
      renamed_columns?: boolean;
      files: { path?: string; deletes?: unknown; bytes?: number; footer_bytes?: number }[];
    }
  >;
};

const getText = async (bucket: R2Bucket, key: string): Promise<string> => {
  const object = await bucket.get(key);
  if (!object) throw new Error(`not found: ${key}`);
  return object.text();
};

const dirOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);

const byTable = (pick: (t: Table) => FileRef[]): Record<Table, FileRef[]> =>
  Object.fromEntries(TABLES.map((t) => [t, pick(t)])) as Record<Table, FileRef[]>;

export const fromManifest = (key: string, m: Manifest): Index => ({
  version: m.version,
  tables: byTable((t) => (m.tables[t] ?? []).map((p) => ({ key: dirOf(key) + p }))),
});

export const fromFileList = (root: string, version: string, list: FileList): Index => ({
  version,
  tables: byTable((t) => {
    const table = list.tables[t];
    if (!table) return [];
    // 削除ファイルや列の改名は、Parquet だけを読むこの Worker では正しく読めない (表はまるごと作り直している)
    if (table.renamed_columns || table.files.some((f) => f.deletes)) {
      throw new Error(`${t} has deletes or renamed columns`);
    }
    return table.files.map((f) => {
      if (!f.path) throw new Error(`${t} has a file outside the repository`);
      return { key: root + f.path, bytes: f.bytes, footer: f.footer_bytes };
    });
  }),
});

const load = async (bucket: R2Bucket, source: string): Promise<Index> => {
  if (source.endsWith(".json")) {
    return fromManifest(source, JSON.parse(await getText(bucket, source)) as Manifest);
  }
  const config = JSON.parse(await getText(bucket, `${source}fdl.json`)) as { data_dir?: string };
  const id = (await getText(bucket, `${source}refs/heads/main`)).trim();
  const list = JSON.parse(await getText(bucket, `${source}versions/${id}/files.json`)) as FileList;
  return fromFileList(source + (config.data_dir ?? "data/"), id, list);
};

/** 読む先を覚えておく時間。Sync のあと、遅くともこれだけたてば新しいバージョンを読む */
const TTL_MS = 5 * 60 * 1000;
let cached: { source: string; at: number; index: Promise<Index> } | null = null;

/** 置き場の索引のファイル一覧。問い合わせのたびに R2 を 3 回読まないよう、TTL_MS のあいだ覚えておく */
export const loadIndex = (bucket: R2Bucket, source: string, now = Date.now()): Promise<Index> => {
  if (cached?.source === source && now - cached.at < TTL_MS) return cached.index;
  const index = load(bucket, source);
  cached = { source, at: now, index };
  // 失敗したら覚えない (次の問い合わせで読み直す)
  index.catch(() => {
    if (cached?.index === index) cached = null;
  });
  return index;
};

/** テーブルのファイルのうち、パスの「shard=値/」が shard のもの */
export const shardFiles = (index: Index, table: Table, shard: string): FileRef[] =>
  index.tables[table].filter((f) => f.key.includes(`/shard=${shard}/`));
