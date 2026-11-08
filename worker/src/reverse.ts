// 法人番号から法人を返す。索引の形は prototype/export_company.py
import { columnStats, openFile, readGroups, type ReadLog } from "./parquet";

type Day = Date | string | null;

export type FormerName = { name: string; until: string | null };
export type FormerAddress = {
  prefecture: string | null;
  city: string | null;
  street_number: string | null;
  lg_code: string | null;
  until: string | null;
};

export type Company = {
  corporate_number: string;
  /** closed は登記記録が閉鎖された法人 (清算の結了・合併による解散など) */
  status: "active" | "closed";
  name: string;
  furigana: string | null;
  /** 法人種別 (国税庁の法人番号公表サイトのコード。301 は株式会社) */
  kind: string;
  prefecture: string | null;
  city: string | null;
  street_number: string | null;
  lg_code: string | null;
  /** 法人番号の指定年月日 (YYYY-MM-DD) */
  assignment_date: string | null;
  close_date: string | null;
  /** 閉鎖の事由のコード。01 は清算の結了等、11 は合併による解散等、21 は登記官による閉鎖、31 はその他の清算の結了等 */
  close_cause: string | null;
  /** 合併で解散した法人の承継先の法人番号 */
  successor_corporate_number: string | null;
  /** 旧商号。古い順。until はその商号でなくなった日 */
  former_names: FormerName[];
  /** 旧所在地。古い順。until はその所在地でなくなった日 */
  former_addresses: FormerAddress[];
};

type Row = {
  corporate_number: string;
  name: string;
  furigana: string | null;
  kind: string;
  prefecture_name: string | null;
  city_name: string | null;
  street_number: string | null;
  lg_code: string | null;
  assignment_date: Day;
  close_date: Day;
  close_cause: string | null;
  successor_corporate_number: string | null;
  former_names: { name: string; until: Day }[] | null;
  former_addresses: (Omit<FormerAddress, "until"> & { until: Day })[] | null;
};

const COLUMNS: (keyof Row)[] = [
  "corporate_number",
  "name",
  "furigana",
  "kind",
  "prefecture_name",
  "city_name",
  "street_number",
  "lg_code",
  "assignment_date",
  "close_date",
  "close_cause",
  "successor_corporate_number",
  "former_names",
  "former_addresses",
];

/** 法人番号は 13 桁の数字 */
export const isCorporateNumber = (s: string): boolean => /^\d{13}$/.test(s);

const toDate = (d: Day): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

const toCompany = ({
  prefecture_name,
  city_name,
  assignment_date,
  close_date,
  former_names,
  former_addresses,
  ...rest
}: Row): Company => ({
  corporate_number: rest.corporate_number,
  status: close_date === null ? "active" : "closed",
  name: rest.name,
  furigana: rest.furigana,
  kind: rest.kind,
  prefecture: prefecture_name,
  city: city_name,
  street_number: rest.street_number,
  lg_code: rest.lg_code,
  assignment_date: toDate(assignment_date),
  close_date: toDate(close_date),
  close_cause: rest.close_cause,
  successor_corporate_number: rest.successor_corporate_number,
  former_names: (former_names ?? []).map((f) => ({ ...f, until: toDate(f.until) })),
  former_addresses: (former_addresses ?? []).map((f) => ({ ...f, until: toDate(f.until) })),
});

export const reverse = async (
  bucket: R2Bucket,
  prefix: string,
  corporateNumber: string,
  log: ReadLog = { reads: 0, bytes: 0 },
): Promise<Company | null> => {
  const file = await openFile(
    bucket,
    `${prefix}company/shard=${corporateNumber.slice(-3)}.parquet`,
    log,
  );
  if (!file) return null;
  const groups = columnStats(file.metadata, "corporate_number").flatMap((s, i) =>
    s.min <= corporateNumber && corporateNumber <= s.max ? [i] : [],
  );
  const rows = await readGroups<Row>(file, groups, COLUMNS);
  const row = rows.find((r) => r.corporate_number === corporateNumber);
  return row ? toCompany(row) : null;
};
