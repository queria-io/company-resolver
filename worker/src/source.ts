import {
  type DataFile,
  open,
  r2Store,
  refreshing,
  tableFiles,
  type Version,
} from "@queria-io/fdl-js";

// 逆引きの索引のファイルの置き場を引く (正引きの索引は静的アセット。src/assets.ts)。Worker が知るのは置き場 (DATA_SOURCE) だけにする。
//   - 「…/」: FDL のデータセット (Queria の company_resolver)。refs/heads/main が指すバージョンの
//     tables.json (テーブルごとのファイル一覧) から引く。毎月の Sync で main が進めば、デプロイなしで読む先が切り替わる
//   - 「….json」: 目録。{ "version": "…", "tables": { "reverse.company": ["reverse/company/shard=001/a.parquet"], … } }。
//     パスは目録からの相対。テストと、セルフホストで自分の Parquet を読ませるときに使う

/** Worker が R2 から読むテーブル (スキーマ.テーブル)。dbt のモデル (models/) と同じ名前 */
export const TABLES = ["reverse.company"] as const;
export type Table = (typeof TABLES)[number];

/** fdl-js のデータファイル。キーはバケットの頭から。目録のファイルは大きさが分からないので、読むときに問い合わせる */
export type FileRef = Omit<DataFile, "rows" | "bytes"> & Partial<Pick<DataFile, "rows" | "bytes">>;
export type Index = { version: string; tables: Record<Table, FileRef[]> };

type Manifest = { version: string; tables: Partial<Record<Table, string[]>> };

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

/**
 * FDL のバージョンの tables.json から、テーブルのファイルを引く。キーは置き場 (root) を頭に付けたパス。
 * 削除ファイルと列の定義も渡し、fdl-js が削除した行を除き、改名した列を今の名前で読む
 */
export const fromVersion = (root: string, version: Version): Index => ({
  version: version.record.id,
  tables: byTable((t) =>
    (tableFiles(version, t) ?? []).map(({ deletes, ...f }) => ({
      ...f,
      key: root + f.key,
      ...(deletes ? { deletes: { ...deletes, key: root + deletes.key } } : {}),
    })),
  ),
});

const load = async (bucket: R2Bucket, source: string): Promise<Index> => {
  if (source.endsWith(".json")) {
    return fromManifest(source, JSON.parse(await getText(bucket, source)) as Manifest);
  }
  return fromVersion(source, await open(r2Store(bucket, source), "refs/heads/main"));
};

/** 読む先を覚えておく時間。Sync のあと、遅くともこれだけたてば新しいバージョンを読む */
const TTL_MS = 5 * 60 * 1000;
const loaders = new Map<string, () => Promise<Index>>();

/**
 * 置き場の索引のファイル一覧。問い合わせのたびに R2 を読まないよう、TTL_MS のあいだ覚えておく。
 * 読み直しに失敗したら前の一覧を使い続ける (refs を読めない一時の失敗で止めない)
 */
export const loadIndex = (bucket: R2Bucket, source: string): Promise<Index> => {
  let loader = loaders.get(source);
  if (!loader) {
    loader = refreshing(() => load(bucket, source), TTL_MS, { onError: console.error });
    loaders.set(source, loader);
  }
  return loader();
};

/** テーブルのファイルのうち、パスの「shard=値/」が shard のもの */
export const shardFiles = (index: Index, table: Table, shard: string): FileRef[] =>
  index.tables[table].filter((f) => f.key.includes(`/shard=${shard}/`));
