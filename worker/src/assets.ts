// 正引きの索引を、Worker と一緒にデプロイした静的アセット (scripts/build-data.mjs が public/data/ に置く) から読む。
// 静的アセットは丸ごとしか読めないので、索引は 1 件の検索で読むファイルが小さくなるように分けてある (dbt_project.yml)
import { parquetReadObjects } from "hyparquet";

import { compressors } from "./parquet";

/** パスのファイルの中身。無ければ null */
export type Files = (path: string) => Promise<ArrayBuffer | null>;

/** 1 回の呼び出しで読んだファイルの数と量 */
export type AssetLog = { reads: number; bytes: number };

/** 静的アセットのバインディングから読む */
export const assetFiles =
  (assets: Fetcher): Files =>
  async (path) => {
    const res = await assets.fetch(new Request(`https://assets.local/${path}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.arrayBuffer();
  };

/**
 * Parquet のファイルを丸ごと読んで行にする。keep のファイルは、同じ呼び出しの中で 2 回読まないよう覚える
 * (まとめて照合するときに、同じファイルを引く問い合わせが重なるため)。大きくなりうるファイル (bigram の索引) は
 * 覚えずに読み捨て、呼び出しの中でメモリが積み上がらないようにする
 */
export const rowReader = (files: Files, log: AssetLog) => {
  const kept = new Map<string, Promise<unknown[]>>();
  const load = (path: string) =>
    files(path).then(async (file) => {
      if (!file) return [];
      log.reads += 1;
      log.bytes += file.byteLength;
      return parquetReadObjects({ file, compressors });
    });
  return <T>(path: string, keep = true): Promise<T[]> => {
    if (!keep) return load(path) as Promise<T[]>;
    let rows = kept.get(path);
    if (!rows) {
      rows = load(path);
      kept.set(path, rows);
    }
    return rows as Promise<T[]>;
  };
};
export type RowReader = ReturnType<typeof rowReader>;

let cachedVersion: Promise<string | null> | null = null;

/** デプロイした索引のバージョン (scripts/build-data.mjs が data/version.json に書く)。isolate の中で 1 回だけ読む */
export const loadVersion = (files: Files): Promise<string | null> => {
  cachedVersion ??= files("data/version.json").then((b) =>
    b ? (JSON.parse(new TextDecoder().decode(b)) as { version: string }).version : null,
  );
  cachedVersion.catch(() => (cachedVersion = null));
  return cachedVersion;
};
