// 企業名と住所から法人番号の候補を返す。規則は DESIGN.md、索引は D1 (scripts/sync_d1.py が models/forward/ から入れる)
import { bigrams, coreName, legalForm, levenshtein, nfkc } from "./normalize";

/** 1 件の検索で引く bigram の数。出現する法人が少ない順に取る */
const RAREST_GRAMS = 8;
/** 全国で引く行の上限。出現する法人が少ない bigram から順に、合計がこれに収まるものだけを全国で引く */
const NATIONAL_ROWS = 10_000;
/** 編集距離で比べる候補の数 (全国と、住所の市区町村の中から、それぞれ) */
const COMPARE_TOP = 100;
/** D1 から返す候補の数 (全国と市区町村の中から、それぞれ)。SQLite では編集距離を計算できないので多めに返す */
const FETCH_TOP = 1000;

export type Input = { name: string; address?: string; limit?: number };

export type City = { lg_code: string; prefecture_name: string; city_name: string };
export type Row = {
  lg_code: string;
  corporate_number: string;
  legal_form: string | null;
  core: string;
  name: string;
};

export type Evidence = {
  name: string;
  legal_form: "exact" | "mismatch" | "missing";
  city: "exact" | "mismatch" | "missing";
};

export type Candidate = {
  corporate_number: string;
  name: string;
  prefecture: string | null;
  city: string | null;
  lg_code: string;
  evidence: Evidence;
};

export type Status = "matched" | "ambiguous" | "candidates" | "not_found";

export type Answer = {
  status: Status;
  /** 入力と商号・法人格が同じ法人の数 (住所の市区町村が分かればその中の数)。数えられないときは null */
  same_name_count: number | null;
  candidates: Candidate[];
};

/** 文をまとめて 1 往復で流し、文ごとの行を返す (Worker では D1 の batch、ベンチマークでは手元の SQLite) */
export type Sql = (statements: { sql: string; params: unknown[] }[]) => Promise<unknown[][]>;

const PREFECTURE_PREFIX = /^(東京都|北海道|京都府|大阪府|.{2,3}県)/;

/**
 * 住所に含まれる市区町村のうち名前が最も長いもの (「札幌市中央区」を「中央区」より優先)。
 * 住所が都道府県名で始まるときは、その都道府県の市区町村だけを見る
 */
export const citiesIn = (address: string, cities: readonly City[]): City[] => {
  const hasPrefecture = PREFECTURE_PREFIX.test(address);
  const hits = cities.filter(
    (c) =>
      c.city_name !== "" &&
      address.includes(c.city_name) &&
      (!hasPrefecture || address.startsWith(c.prefecture_name)),
  );
  const longest = Math.max(0, ...hits.map((c) => c.city_name.length));
  return hits.filter((c) => c.city_name.length === longest);
};

const CITIES = "SELECT lg_code, prefecture_name, city_name FROM city";

/** 市区町村の一覧を覚えておく時間。毎月の反映のあと、遅くともこれだけたてば新しい一覧を使う */
const CITY_TTL_MS = 5 * 60 * 1000;
let cachedCities: { at: number; cities: Promise<City[]> } | null = null;

/** 市区町村の一覧 (約 1,900 行)。問い合わせのたびに D1 から読まないよう、CITY_TTL_MS のあいだ覚えておく */
export const loadCities = (sql: Sql, now = Date.now()): Promise<City[]> => {
  if (cachedCities && now - cachedCities.at < CITY_TTL_MS) return cachedCities.cities;
  const cities = sql([{ sql: CITIES, params: [] }]).then(([rows]) => rows as City[]);
  const entry = { at: now, cities };
  cachedCities = entry;
  // 失敗したら覚えない (次の問い合わせで読み直す)
  cities.catch(() => {
    if (cachedCities === entry) cachedCities = null;
  });
  return cities;
};

const EXACT =
  "SELECT corporate_number, core, legal_form, lg_code, name FROM company WHERE core = ?1";

// 出現する法人が少ない bigram RAREST_GRAMS 個を引き、最も珍しいものと、合計 NATIONAL_ROWS 行に収まるものは
// 全国、すべての bigram は住所の市区町村の中で、IDF の合計の上位を取る。合計が同じなら商号の長さの差の
// 小さい順に FETCH_TOP 件を返し、編集距離で COMPARE_TOP 件に絞るのは Worker
const FUZZY = `
WITH chosen AS (
  SELECT g, idf, row_number() OVER w AS rn, sum(df) OVER w AS cum
  FROM gram WHERE g IN (SELECT value FROM json_each(?1))
  WINDOW w AS (ORDER BY df, g) ORDER BY df, g LIMIT ${RAREST_GRAMS}
),
national AS (
  SELECT p.corporate_number, sum(c.idf) AS score FROM chosen c JOIN posting p ON p.g = c.g
  WHERE c.rn = 1 OR c.cum <= ${NATIONAL_ROWS} GROUP BY 1
),
local AS (
  SELECT p.corporate_number, sum(c.idf) AS score FROM chosen c JOIN posting p ON p.g = c.g
  WHERE p.lg_code IN (SELECT value FROM json_each(?2)) GROUP BY 1
)
SELECT * FROM (
  SELECT 'national' AS part, s.score, co.* FROM national s JOIN company co USING (corporate_number)
  ORDER BY s.score DESC, abs(length(co.core) - length(?3)) LIMIT ${FETCH_TOP})
UNION ALL
SELECT * FROM (
  SELECT 'local' AS part, s.score, co.* FROM local s JOIN company co USING (corporate_number)
  ORDER BY s.score DESC, abs(length(co.core) - length(?3)) LIMIT ${FETCH_TOP})`;

type Scored = Row & { part: "national" | "local"; score: number };

export type Ranked = { p: Row; ed: number; cityOk: boolean };

/** IDF の合計の上位 COMPARE_TOP 件。合計が同じなら商号の編集距離の小さい順 */
const topByScore = (rows: readonly Scored[], core: string): Scored[] =>
  rows
    .map((r) => ({ r, ed: levenshtein(core, r.core) }))
    .sort(
      (a, b) =>
        b.r.score - a.r.score ||
        a.ed - b.ed ||
        a.r.corporate_number.localeCompare(b.r.corporate_number),
    )
    .slice(0, COMPARE_TOP)
    .map(({ r }) => r);

/** 照合の結果を応答の形にする */
const answerOf = (
  input: Input,
  cities: readonly City[],
  cityCodes: ReadonlySet<string>,
  status: Status,
  sameCount: number | null,
  ranked: readonly Ranked[],
): Answer => {
  const name = nfkc(input.name);
  const lf = legalForm(name);
  const cityOf = new Map(cities.map((c) => [c.lg_code, c]));
  return {
    status,
    same_name_count: sameCount,
    candidates: ranked.slice(0, input.limit ?? 5).map(({ p, ed, cityOk }) => ({
      corporate_number: p.corporate_number,
      name: p.name,
      prefecture: cityOf.get(p.lg_code)?.prefecture_name ?? null,
      city: cityOf.get(p.lg_code)?.city_name ?? null,
      lg_code: p.lg_code,
      evidence: {
        name: ed > 0 ? `edit(${ed})` : name === p.name ? "exact" : "normalized",
        legal_form: lf === null ? "missing" : lf === p.legal_form ? "exact" : "mismatch",
        city: !input.address || cityCodes.size === 0 ? "missing" : cityOk ? "exact" : "mismatch",
      },
    })),
  };
};

/**
 * 正引き。商号が同じ法人の検索と bigram の索引の検索を、D1 への 1 回の往復 (batch) で行う。
 * 商号と法人格 (と住所の市区町村) が一致する法人が 1 件だけなら、それで答える (matched)。
 * それ以外は bigram の索引で見つけた近い商号を候補に並べる
 */
export const forward = async (sql: Sql, cities: readonly City[], input: Input): Promise<Answer> => {
  const name = nfkc(input.name);
  const lf = legalForm(name);
  const core = coreName(name);
  const inCity = input.address ? citiesIn(nfkc(input.address), cities) : [];
  const cityCodes = new Set(inCity.map((c) => c.lg_code));
  const legalOk = (p: Row) => lf === null || lf === p.legal_form;
  const cityOk = (p: Row) => cityCodes.has(p.lg_code);

  const [exact, fuzzy] = (await sql([
    { sql: EXACT, params: [core] },
    { sql: FUZZY, params: [JSON.stringify(bigrams(core)), JSON.stringify([...cityCodes]), core] },
  ])) as [Row[], Scored[]];
  // 住所の市区町村が分かるときは、市区町村まで一致して初めて商号の一致とみなす
  const same = exact.filter((p) => legalOk(p) && (cityCodes.size === 0 || cityOk(p)));
  if (same.length === 1) {
    // 商号が同じで法人格や市区町村が違う法人も、後ろの候補に並べる
    const ranked = exact
      .map((p) => ({ p, ed: 0, cityOk: cityOk(p) }))
      .sort(
        (a, b) =>
          Number(b.cityOk) - Number(a.cityOk) ||
          Number(legalOk(b.p)) - Number(legalOk(a.p)) ||
          a.p.corporate_number.localeCompare(b.p.corporate_number),
      );
    return answerOf(input, cities, cityCodes, "matched", 1, ranked);
  }

  const picked = [
    ...topByScore(
      fuzzy.filter((r) => r.part === "national"),
      core,
    ),
    ...topByScore(
      fuzzy.filter((r) => r.part === "local"),
      core,
    ),
  ];
  const best = new Map<string, Scored>();
  for (const r of picked) {
    if ((best.get(r.corporate_number)?.score ?? -1) < r.score) best.set(r.corporate_number, r);
  }
  const ranked = [...best.values()]
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
  // 商号が同じ法人が 1 件なら上で答えているので、ここで商号が一致するのは同じ条件の法人が複数あるとき
  const isExact =
    top !== undefined && top.ed === 0 && top.legal && (cityCodes.size === 0 || top.cityOk);
  const status: Status = isExact ? "ambiguous" : ranked.length > 0 ? "candidates" : "not_found";
  const sameCount = fuzzy.length > 0 || exact.length > 0 ? same.length : null;
  return answerOf(input, cities, cityCodes, status, sameCount, ranked);
};
