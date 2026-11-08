// R2 の Parquet を Range で読む。DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
  parquetMetadata,
  parquetReadObjects,
} from "hyparquet";

// 索引は zstd で書いている (prototype/export_parquet.py)。fzstd は純粋な JS なので Workers でそのまま動く
const compressors: Compressors = { ZSTD: (input) => decompress(input) };

/** 1 回の問い合わせで R2 から読んだ回数と量 */
export type ReadLog = { reads: number; bytes: number };

/** フッターを 1 回の読みで取るために、末尾から読む長さ。索引のフッターはこれに収まる大きさにしてある */
const TAIL_BYTES = 32 * 1024;

const rangeBuffer = (
  bucket: R2Bucket,
  key: string,
  byteLength: number,
  log: ReadLog,
): AsyncBuffer => ({
  byteLength,
  slice: async (start, end = byteLength) => {
    const object = await bucket.get(key, { range: { offset: start, length: end - start } });
    if (!object) throw new Error(`not found: ${key}`);
    log.reads += 1;
    log.bytes += end - start;
    return object.arrayBuffer();
  },
});

export type ParquetFile = { file: AsyncBuffer; metadata: FileMetaData };

/**
 * ファイルを開く。末尾を 1 回読んでフッターを取る (フッターが TAIL_BYTES より長ければもう 1 回)。
 * ファイルが無ければ null
 */
export const openFile = async (
  bucket: R2Bucket,
  key: string,
  log: ReadLog,
): Promise<ParquetFile | null> => {
  const tail = await bucket.get(key, { range: { suffix: TAIL_BYTES } });
  if (!tail) return null;
  const buffer = await tail.arrayBuffer();
  log.reads += 1;
  log.bytes += buffer.byteLength;
  const file = rangeBuffer(bucket, key, tail.size, log);
  const footerLength = new DataView(buffer).getUint32(buffer.byteLength - 8, true) + 8;
  const footer =
    footerLength <= buffer.byteLength
      ? buffer.slice(buffer.byteLength - footerLength)
      : await file.slice(tail.size - footerLength);
  return { file, metadata: parquetMetadata(footer) };
};

/** ファイルを丸ごと読む (小さいファイル用)。ファイルが無ければ null */
export const readWhole = async <T>(
  bucket: R2Bucket,
  key: string,
  log: ReadLog,
): Promise<T[] | null> => {
  const object = await bucket.get(key);
  if (!object) return null;
  const file = await object.arrayBuffer();
  log.reads += 1;
  log.bytes += file.byteLength;
  return (await parquetReadObjects({ file, compressors })) as T[];
};

type Stats = { min: string; max: string };

/** 行グループごとの列 column の最小・最大 */
export const columnStats = (metadata: FileMetaData, column: string): Stats[] => {
  const index = metadata.schema.findIndex((s) => s.name === column) - 1;
  return metadata.row_groups.map((group) => {
    const stats = group.columns[index]?.meta_data?.statistics;
    return {
      min: String(stats?.min_value ?? stats?.min ?? ""),
      max: String(stats?.max_value ?? stats?.max ?? "￿"),
    };
  });
};

/** 行グループの番号を選んで、その行を読む */
export const readGroups = async <T>(
  { file, metadata }: ParquetFile,
  groups: readonly number[],
  columns: string[],
): Promise<T[]> => {
  const starts = metadata.row_groups.reduce<number[]>(
    (acc, group) => [...acc, acc[acc.length - 1] + Number(group.num_rows)],
    [0],
  );
  const rows = await Promise.all(
    groups.map((g) =>
      parquetReadObjects({
        file,
        metadata,
        columns,
        compressors,
        rowStart: starts[g],
        rowEnd: starts[g + 1],
      }),
    ),
  );
  return rows.flat() as T[];
};
