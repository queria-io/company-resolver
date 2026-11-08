// 商号の正規化。prototype/normalize.sql と同じ規則にする (索引はその SQL で作るため)

const LEGAL_FORMS = [
  ["株式会社", "(株)"],
  ["有限会社", "(有)"],
  ["合同会社", "(同)"],
  ["合資会社", "(資)"],
  ["合名会社", "(名)"],
] as const;

const LEGAL_FORM_PATTERN = /株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)/g;
// 空白・中黒・ハイフン類。空白は normalize.sql (RE2 の \s) と同じ ASCII の空白だけにする
const SEPARATORS = /[\t\n\f\r ・‐―−–—-]/g;
// 商業登記では小書きの仮名を使えないため、大きい仮名に揃える
const SMALL_KANA = "ァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ";
const LARGE_KANA = "アイウエオツヤユヨワカケあいうえおつやゆよわ";

export const nfkc = (s: string): string => s.normalize("NFKC");

/** 商号に含まれる法人格。無ければ null (NFKC 済みの文字列を受け取る) */
export const legalForm = (name: string): string | null =>
  LEGAL_FORMS.find(([full, short]) => name.includes(full) || name.includes(short))?.[0] ?? null;

const largeKana = (s: string): string =>
  Array.from(s, (c) => {
    const i = SMALL_KANA.indexOf(c);
    return i < 0 ? c : LARGE_KANA[i];
  }).join("");

/** 法人格と区切りの記号を除いた商号の本体 (NFKC 済みの文字列を受け取る) */
export const coreName = (name: string): string =>
  largeKana(name.replace(LEGAL_FORM_PATTERN, "").replace(SEPARATORS, "").toUpperCase());

/** 文字 bigram (重複を除く)。1 文字の商号はその 1 文字 */
export const bigrams = (core: string): string[] => {
  const chars = Array.from(core);
  if (chars.length <= 1) return chars;
  return [...new Set(chars.slice(1).map((c, i) => chars[i] + c))];
};

/** 索引のファイル番号。bigram の文字のコードポイントの和を shards で割った余り */
export const shardOf = (gram: string, shards: number): number =>
  Array.from(gram).reduce((sum, c) => sum + (c.codePointAt(0) ?? 0), 0) % shards;

/** 文字単位の編集距離 */
export const levenshtein = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 0; i < x.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < y.length; j++) {
      row.push(Math.min(prev[j + 1] + 1, row[j] + 1, prev[j] + (x[i] === y[j] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[y.length];
};

/** コードポイント順の比較。Parquet の文字列の統計 (UTF-8 のバイト順) と同じ順になる */
export const compareCodePoints = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};
