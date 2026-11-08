// 法人番号から法人を返す。索引の形は prototype/export_parquet.py の company/
import { columnStats, openFile, readGroups, type ReadLog } from "./parquet";

export type Company = {
  corporate_number: string;
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
};

type Row = Omit<Company, "prefecture" | "city" | "assignment_date"> & {
  prefecture_name: string | null;
  city_name: string | null;
  assignment_date: Date | string | null;
};

/** 法人番号は 13 桁の数字 */
export const isCorporateNumber = (s: string): boolean => /^\d{13}$/.test(s);

const toDate = (d: Row["assignment_date"]): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

export const reverse = async (
  bucket: R2Bucket,
  prefix: string,
  corporateNumber: string,
  log: ReadLog = { reads: 0, bytes: 0 },
): Promise<Company | null> => {
  const file = await openFile(
    bucket,
    `${prefix}company/shard=${corporateNumber.slice(-2)}.parquet`,
    log,
  );
  if (!file) return null;
  const groups = columnStats(file.metadata, "corporate_number").flatMap((s, i) =>
    s.min <= corporateNumber && corporateNumber <= s.max ? [i] : [],
  );
  const rows = await readGroups<Row>(file, groups, [
    "corporate_number",
    "name",
    "furigana",
    "kind",
    "prefecture_name",
    "city_name",
    "street_number",
    "lg_code",
    "assignment_date",
  ]);
  const row = rows.find((r) => r.corporate_number === corporateNumber);
  if (!row) return null;
  const { prefecture_name, city_name, assignment_date, ...rest } = row;
  return {
    ...rest,
    prefecture: prefecture_name,
    city: city_name,
    assignment_date: toDate(assignment_date),
  };
};
