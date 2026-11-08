// 商号の正規化。prototype/normalize.sql と同じ規則にする (索引はその SQL で作るため)

const LEGAL_FORMS = [
  ["株式会社", "(株)"],
  ["有限会社", "(有)"],
  ["合同会社", "(同)"],
  ["合資会社", "(資)"],
  ["合名会社", "(名)"],
] as const;

const LEGAL_FORM_PATTERN = /株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)/g;
// 空白・中黒・ハイフン類
const SEPARATORS = /[\s・‐―−–—-]/g;
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
  const last = x.reduce(
    (prev, cx, i) =>
      y.reduce<number[]>(
        (row, cy, j) => [
          ...row,
          Math.min(prev[j + 1] + 1, row[j] + 1, prev[j] + (cx === cy ? 0 : 1)),
        ],
        [i + 1],
      ),
    Array.from({ length: y.length + 1 }, (_, j) => j),
  );
  return last[y.length];
};
