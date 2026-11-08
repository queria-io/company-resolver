// 正引きを D1 の 1 回の問い合わせ (batch) で行う。D1 と R2 の比較の計測用 (README.md)。
// 規則は src/forward.ts と同じ: 商号が同じ法人が 1 件に決まれば matched、それ以外は bigram の索引で検索する
import {
  type Answer,
  answerOf,
  type City,
  citiesIn,
  type Input,
  type Ranked,
  type Row,
  type Status,
} from "../../src/forward";
import { bigrams, coreName, legalForm, levenshtein, nfkc } from "../../src/normalize";

/** 文をまとめて 1 往復で流し、文ごとの行を返す (D1 の batch か、手元の SQLite) */
export type Sql = (statements: { sql: string; params: unknown[] }[]) => Promise<unknown[][]>;

const EXACT =
  "SELECT corporate_number, core, legal_form, lg_code, name FROM company WHERE core = ?1";

// src/forward.ts と同じく、出現する法人が少ない bigram 8 個を引き、最も珍しいものと合計 10,000 行に収まる
// ものは全国、すべての bigram は住所の市区町村の中で、IDF の合計の上位を取る。SQLite では編集距離を
// 計算できないので、合計が同じなら商号の長さの差の小さい順に 300 件を返し、編集距離で 100 件に絞るのは Worker
const FUZZY = `
WITH chosen AS (
  SELECT g, idf, row_number() OVER w AS rn, sum(df) OVER w AS cum
  FROM gram WHERE g IN (SELECT value FROM json_each(?1))
  WINDOW w AS (ORDER BY df, g) ORDER BY df, g LIMIT 8
),
national AS (
  SELECT p.corporate_number, sum(c.idf) AS score FROM chosen c JOIN posting p ON p.g = c.g
  WHERE c.rn = 1 OR c.cum <= 10000 GROUP BY 1
),
local AS (
  SELECT p.corporate_number, sum(c.idf) AS score FROM chosen c JOIN posting p ON p.g = c.g
  WHERE p.lg_code IN (SELECT value FROM json_each(?2)) GROUP BY 1
)
SELECT * FROM (
  SELECT 'national' AS part, s.score, co.* FROM national s JOIN company co USING (corporate_number)
  ORDER BY s.score DESC, abs(length(co.core) - length(?3)) LIMIT 300)
UNION ALL
SELECT * FROM (
  SELECT 'local' AS part, s.score, co.* FROM local s JOIN company co USING (corporate_number)
  ORDER BY s.score DESC, abs(length(co.core) - length(?3)) LIMIT 300)`;

type Scored = Row & { part: "national" | "local"; score: number };

const top100 = (rows: Scored[], core: string) =>
  rows
    .map((r) => ({ r, ed: levenshtein(core, r.core) }))
    .sort(
      (a, b) =>
        b.r.score - a.r.score ||
        a.ed - b.ed ||
        a.r.corporate_number.localeCompare(b.r.corporate_number),
    )
    .slice(0, 100)
    .map(({ r }) => r);

export const forwardD1 = async (
  sql: Sql,
  cities: readonly City[],
  input: Input,
): Promise<Answer> => {
  const name = nfkc(input.name);
  const lf = legalForm(name);
  const core = coreName(name);
  const inCity = input.address ? citiesIn(nfkc(input.address), cities) : [];
  const cityCodes = new Set(inCity.map((c) => c.lg_code));
  const legalOk = (p: Row) => lf === null || lf === p.legal_form;
  const cityOk = (p: Row) => cityCodes.has(p.lg_code);

  const [exact, fuzzy] = await sql([
    { sql: EXACT, params: [core] },
    { sql: FUZZY, params: [JSON.stringify(bigrams(core)), JSON.stringify([...cityCodes]), core] },
  ]);
  const same = (exact as Row[]).filter(legalOk).filter((p) => cityCodes.size === 0 || cityOk(p));
  if (same.length === 1)
    return answerOf(input, cities, cityCodes, "matched", 1, [
      { p: same[0], ed: 0, cityOk: cityOk(same[0]) },
    ]);

  const rows = fuzzy as Scored[];
  const picked = [
    ...top100(
      rows.filter((r) => r.part === "national"),
      core,
    ),
    ...top100(
      rows.filter((r) => r.part === "local"),
      core,
    ),
  ];
  const best = new Map<string, Scored>();
  for (const r of picked)
    if ((best.get(r.corporate_number)?.score ?? -1) < r.score) best.set(r.corporate_number, r);
  const ranked: (Ranked & { legal: boolean; score: number })[] = [...best.values()]
    .map((p) => ({
      p,
      score: p.score,
      ed: levenshtein(core, p.core),
      cityOk: cityOk(p),
      legal: legalOk(p),
    }))
    .sort(
      (a, b) =>
        a.ed + (a.cityOk ? 0 : 2) - (b.ed + (b.cityOk ? 0 : 2)) ||
        a.ed - b.ed ||
        Number(b.legal) - Number(a.legal) ||
        b.score - a.score ||
        a.p.corporate_number.localeCompare(b.p.corporate_number),
    );
  const top = ranked[0];
  const isExact =
    top !== undefined && top.ed === 0 && top.legal && (cityCodes.size === 0 || top.cityOk);
  const status: Status = isExact
    ? same.length === 1
      ? "matched"
      : "ambiguous"
    : ranked.length > 0
      ? "candidates"
      : "not_found";
  return answerOf(
    input,
    cities,
    cityCodes,
    status,
    rows.length > 0 || exact.length > 0 ? same.length : null,
    ranked,
  );
};
