// 企業名と住所から法人番号の候補を返す。規則は DESIGN.md、索引は models/forward/ の dbt のモデルを静的アセットに置いたもの
import { type RowReader } from "./assets";
import { bigrams, cityBucket, coreName, legalForm, levenshtein, nfkc, shardOf } from "./normalize";

/** 1 件の検索で引く bigram の数。出現する法人が少ない順に取る */
const RAREST_GRAMS = 8;
/** 全国で読む行の上限。出現する法人が少ない bigram から順に、合計がこれに収まるものだけを全国で読む */
const NATIONAL_ROWS = 10_000;
/** まとめて照合するとき、同時に進める近い商号の検索の数 (読んだ行を持つメモリを抑える) */
const FUZZY_CONCURRENCY = 1;
/** 編集距離で比べる候補の数 (全国と、住所の市区町村の中から、それぞれ) */
const COMPARE_TOP = 100;
/** 索引のファイルの分け方。dbt_project.yml の vars と同じ値にする */
const NAME_SHARDS = 8192;
const GRAM_SHARDS = 1024;
const RARE_SHARDS = 8192;
const CITY_BUCKETS = 64;

export type Input = { name: string; address?: string; limit?: number };

/**
 * 照合の規則 (DESIGN.md の「照合の規則」の表と同じ ID)。bench/ablate.ts が 1 つずつ外して、精度への効き目を測る。
 * 正規化の規則は索引の作り方と一緒に変わるので、ここには含めない
 */
export const RULES = [
  "exact_first",
  "legal_form",
  "city_match",
  "city_search",
  "city_rank",
  "same_name_candidates",
] as const;
export type Rule = (typeof RULES)[number];

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

let cachedCities: Promise<City[]> | null = null;

/**
 * 市区町村の一覧 (約 1,900 行)。静的アセットはデプロイと一緒にしか変わらないので、isolate の中で 1 回だけ読む。
 * 失敗したときと空だったときは覚えない (次の問い合わせで読み直す)
 */
export const loadCities = (read: RowReader): Promise<City[]> => {
  if (cachedCities) return cachedCities;
  const cities = read<City>("data/city.parquet");
  cachedCities = cities;
  const forget = () => {
    if (cachedCities === cities) cachedCities = null;
  };
  cities.then((rows) => rows.length === 0 && forget(), forget);
  return cities;
};

type Gram = { g: string; df: number | bigint; idf: number; common_id: number | null };
type Posting = Row & { g: string };
/** 引く bigram と、全国で読むか */
type Chosen = { g: string; df: number; idf: number; commonId: number | null; national: boolean };

const exactPath = (core: string) => `data/exact_name/${shardOf(core, NAME_SHARDS)}.parquet`;
const gramPath = (g: string) => `data/gram/${shardOf(g, GRAM_SHARDS)}.parquet`;
const rarePath = (g: string) => `data/posting_rare/${shardOf(g, RARE_SHARDS)}.parquet`;
const commonPath = (id: number, bucket: number) => `data/posting_common/${id}/${bucket}.parquet`;

export type Ranked = { p: Row; ed: number; cityOk: boolean };

/**
 * IDF の合計の上位 COMPARE_TOP 件の法人番号と合計。合計が同じなら商号の編集距離の小さい順
 * (全国で読む bigram が少なく同じ合計の法人が多いとき、入力に近い商号を落とさないため)
 */
const topByScore = (
  rows: readonly Posting[],
  idf: ReadonlyMap<string, number>,
  core: string,
): Map<string, number> => {
  const scores = new Map<string, number>();
  const distance = new Map<string, number>();
  for (const r of rows) {
    scores.set(r.corporate_number, (scores.get(r.corporate_number) ?? 0) + (idf.get(r.g) ?? 0));
    // 法人ごとに 1 回だけ計算する (rows には同じ法人が bigram の数だけある)
    if (!distance.has(r.corporate_number))
      distance.set(r.corporate_number, levenshtein(core, r.core));
  }
  return new Map(
    [...scores]
      .sort(
        ([a, x], [b, y]) =>
          y - x || (distance.get(a) ?? 0) - (distance.get(b) ?? 0) || a.localeCompare(b),
      )
      .slice(0, COMPARE_TOP),
  );
};

/** 1 件の問い合わせを、正規化した商号と住所の市区町村にしたもの */
type Query = {
  input: Input;
  /** 規則を使うか (外した規則は false) */
  on: (rule: Rule) => boolean;
  name: string;
  lf: string | null;
  core: string;
  cityCodes: ReadonlySet<string>;
  legalOk: (p: Row) => boolean;
  cityOk: (p: Row) => boolean;
};

/** 照合の結果を応答の形にする */
const answerOf = (
  q: Query,
  cityOf: ReadonlyMap<string, City>,
  status: Status,
  sameCount: number | null,
  ranked: readonly Ranked[],
): Answer => {
  const { input, name, lf, cityCodes } = q;
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

const queryOf = (input: Input, cities: readonly City[], off: ReadonlySet<Rule>): Query => {
  const on = (rule: Rule) => !off.has(rule);
  const name = nfkc(input.name);
  const lf = legalForm(name);
  const cityCodes = new Set(
    (input.address ? citiesIn(nfkc(input.address), cities) : []).map((c) => c.lg_code),
  );
  return {
    input,
    on,
    name,
    lf,
    core: coreName(name),
    cityCodes,
    // legal_form: 入力に法人格があれば、法人格が同じ法人だけを一致とみなす
    legalOk: (p) => !on("legal_form") || lf === null || lf === p.legal_form,
    cityOk: (p) => cityCodes.has(p.lg_code),
  };
};

/** city_match: 住所の市区町村が分かるときは、市区町村まで一致して初めて一致とみなす */
const cityMatches = (q: Query, p: Row): boolean =>
  !q.on("city_match") || q.cityCodes.size === 0 || q.cityOk(p);

/** 商号が同じ法人のうち、法人格 (住所の市区町村が分かれば市区町村も) が一致するもの */
const sameOf = (q: Query, exact: readonly Row[]): Row[] =>
  exact.filter((p) => q.legalOk(p) && cityMatches(q, p));

/**
 * 商号が同じ法人で答えが決まれば、その応答。商号と法人格 (住所の市区町村が分かれば市区町村も) が一致する
 * 法人が 1 件だけなら matched。決まらなければ null
 */
const answerByExact = (
  q: Query,
  cityOf: ReadonlyMap<string, City>,
  exact: readonly Row[],
): Answer | null => {
  // exact_first: 商号が同じ法人で 1 件に決まれば、bigram の索引を引かずに答える
  if (!q.on("exact_first") || sameOf(q, exact).length !== 1) return null;
  // 商号が同じで法人格や市区町村が違う法人も、後ろの候補に並べる
  const ranked = exact
    .map((p) => ({ p, ed: 0, cityOk: q.cityOk(p) }))
    .sort(
      (a, b) =>
        Number(b.cityOk) - Number(a.cityOk) ||
        Number(q.legalOk(b.p)) - Number(q.legalOk(a.p)) ||
        a.p.corporate_number.localeCompare(b.p.corporate_number),
    );
  return answerOf(q, cityOf, "matched", 1, ranked);
};

/**
 * 引く bigram: 出現する法人が少ない順に RAREST_GRAMS 個。合計が NATIONAL_ROWS に収まるものは全国で読む。
 * 共通の bigram (出現が NATIONAL_ROWS を超える) は全国では読まない (1 件で数十万行になり、Worker のメモリに収まらない)
 */
const chooseGrams = async (q: Query, read: RowReader): Promise<Chosen[]> => {
  const wanted = new Set(bigrams(q.core));
  const shards = [...new Set([...wanted].map(gramPath))];
  const rows = (await Promise.all(shards.map((p) => read<Gram>(p)))).flat();
  let total = 0;
  return rows
    .filter((r) => wanted.has(r.g))
    .map((r) => ({ g: r.g, df: Number(r.df), idf: r.idf, commonId: r.common_id }))
    .sort((a, b) => a.df - b.df || (a.g < b.g ? -1 : 1))
    .slice(0, RAREST_GRAMS)
    .map((r) => {
      total += r.df;
      return { ...r, national: r.commonId === null && total <= NATIONAL_ROWS };
    });
};

/**
 * 引く bigram の行。全国で読む bigram は全部の行、残りは住所の市区町村の行だけ。共通でない bigram は bigram の
 * shard のファイル、共通の bigram (common_id がある) は市区町村の区分ごとのファイルにある (全国では読まない)
 */
const postingsOf = async (
  q: Query,
  chosen: readonly Chosen[],
  read: RowReader,
): Promise<Posting[]> => {
  const buckets = [...new Set([...q.cityCodes].map((c) => cityBucket(c, CITY_BUCKETS)))];
  // city_search: 全国で読まない bigram も、住所の市区町村の中では読む
  const local = q.on("city_search") && q.cityCodes.size > 0;
  const reads = chosen.flatMap((c) => {
    if (!c.national && !local) return [];
    const { commonId } = c;
    const paths = commonId === null ? [rarePath(c.g)] : buckets.map((b) => commonPath(commonId, b));
    return paths.map(async (p) =>
      (await read<Posting>(p, false)).filter(
        (r) => r.g === c.g && (c.national || q.cityCodes.has(r.lg_code)),
      ),
    );
  });
  return (await Promise.all(reads)).flat();
};

/** bigram の索引で見つけた近い商号を候補に並べた応答 */
const answerByFuzzy = (
  q: Query,
  cityOf: ReadonlyMap<string, City>,
  exact: readonly Row[],
  chosen: readonly Chosen[],
  rows: readonly Posting[],
): Answer => {
  const idf = new Map(chosen.map((c) => [c.g, c.idf]));
  const nationalGrams = new Set(chosen.filter((c) => c.national).map((c) => c.g));
  // same_name_candidates: 商号が同じ法人は、引いた bigram をすべて持つ行として全国の候補に加える
  // (住所が無く、共通の bigram しか持たない商号でも、同じ商号の法人を候補に並べるため)
  const sameName = q.on("same_name_candidates")
    ? exact.flatMap((p) => chosen.map((c) => ({ ...p, g: c.g })))
    : [];
  const national = topByScore(
    [...rows.filter((p) => nationalGrams.has(p.g)), ...sameName],
    idf,
    q.core,
  );
  const local = topByScore(
    rows.filter((p) => q.on("city_search") && q.cityCodes.has(p.lg_code)),
    idf,
    q.core,
  );
  // city_rank: 住所の市区町村が違う候補は、商号の編集距離 2 つ分だけ後ろに並べる
  const penalty = (cityOk: boolean) => (cityOk || !q.on("city_rank") ? 0 : 2);
  const byNumber = new Map([...rows, ...sameName].map((p) => [p.corporate_number, p]));
  const ranked = [...new Set([...national.keys(), ...local.keys()])]
    .flatMap((cn) => {
      const p = byNumber.get(cn);
      if (!p) return [];
      const score = Math.max(national.get(cn) ?? 0, local.get(cn) ?? 0);
      return [
        { p, score, ed: levenshtein(q.core, p.core), cityOk: q.cityOk(p), legal: q.legalOk(p) },
      ];
    })
    .sort(
      (a, b) =>
        a.ed + penalty(a.cityOk) - (b.ed + penalty(b.cityOk)) ||
        a.ed - b.ed ||
        Number(b.legal) - Number(a.legal) ||
        b.score - a.score ||
        a.p.corporate_number.localeCompare(b.p.corporate_number),
    );
  const top = ranked[0];
  const isExact = top !== undefined && top.ed === 0 && top.legal && cityMatches(q, top.p);
  const sameCount = chosen.length > 0 || exact.length > 0 ? sameOf(q, exact).length : null;
  // 商号が同じ条件の法人が 1 件なら matched (ふつうは answerByExact で答えている)、複数なら ambiguous
  const status: Status = isExact
    ? sameCount === 1
      ? "matched"
      : "ambiguous"
    : ranked.length > 0
      ? "candidates"
      : "not_found";
  return answerOf(q, cityOf, status, sameCount, ranked);
};

/**
 * 正引き。まず商号が同じ法人を引き、それで答えが決まらない問い合わせだけ bigram の索引で近い商号を検索する。
 * 複数の問い合わせは並べて読む (同じファイルは 1 回だけ読む)。応答は inputs と同じ順
 */
export const forwardMany = async (
  read: RowReader,
  cities: readonly City[],
  inputs: readonly Input[],
  off: ReadonlySet<Rule> = new Set(),
): Promise<Answer[]> => {
  const queries = inputs.map((input) => queryOf(input, cities, off));
  const cityOf = new Map(cities.map((c) => [c.lg_code, c]));
  const exact = await Promise.all(
    queries.map(async (q) =>
      q.core === "" ? [] : (await read<Row>(exactPath(q.core))).filter((p) => p.core === q.core),
    ),
  );
  const answers = queries.map((q, i) => answerByExact(q, cityOf, exact[i]));
  const rest = queries.flatMap((_, i) => (answers[i] === null ? [i] : []));
  // 近い商号の検索は FUZZY_CONCURRENCY 件ずつ進める (1 件で数 MB を読むので、全部を並べるとメモリが足りない)
  await Promise.all(
    Array.from({ length: FUZZY_CONCURRENCY }, async () => {
      for (let i = rest.shift(); i !== undefined; i = rest.shift()) {
        const q = queries[i];
        const chosen = await chooseGrams(q, read);
        answers[i] = answerByFuzzy(q, cityOf, exact[i], chosen, await postingsOf(q, chosen, read));
      }
    }),
  );
  return answers.map((a, i) => a ?? answerByFuzzy(queries[i], cityOf, exact[i], [], []));
};

/** 1 件の正引き */
export const forward = async (
  read: RowReader,
  cities: readonly City[],
  input: Input,
  off: ReadonlySet<Rule> = new Set(),
): Promise<Answer> => (await forwardMany(read, cities, [input], off))[0];
