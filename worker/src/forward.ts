// 企業名と住所から法人番号の候補を返す。規則は DESIGN.md、索引の形は prototype/export_parquet.py
import {
  bigrams,
  compareCodePoints,
  coreName,
  legalForm,
  levenshtein,
  nfkc,
  shardOf,
} from "./normalize";
import {
  columnStats,
  openFile,
  type ParquetFile,
  readGroups,
  readWhole,
  type ReadLog,
} from "./parquet";

/** 索引のファイルの数 (export_parquet.py の SHARDS) */
const SHARDS = 1024;
/** 1 件の検索で引く bigram の数。出現する法人が少ない順に取る */
const RAREST_GRAMS = 8;
/** 編集距離で比べる候補の数 (全国と、住所の市区町村の中から、それぞれ) */
const COMPARE_TOP = 100;
/** 全国から読む行の上限。出現する法人が少ない bigram から順に、合計がこれに収まるものだけを全国で読む */
const NATIONAL_READ_ROWS = 10_000;

export type Input = { name: string; address?: string; limit?: number };

type Gram = { g: string; df: number; idf: number };
type City = { lg_code: string; prefecture_name: string; city_name: string };
type Posting = {
  g: string;
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

/**
 * IDF の合計の上位 COMPARE_TOP 件。合計が同じなら、商号の編集距離の小さい順
 * (全国で読む bigram が少なく同じ合計の法人が多いとき、入力に近い商号を落とさないため)
 */
const topByScore = (
  rows: readonly Posting[],
  idf: ReadonlyMap<string, number>,
  core: string,
): Map<string, number> => {
  const scores = rows.reduce(
    (acc, r) =>
      acc.set(r.corporate_number, (acc.get(r.corporate_number) ?? 0) + (idf.get(r.g) ?? 0)),
    new Map<string, number>(),
  );
  // 法人ごとに 1 回だけ計算する (rows には同じ法人が bigram の数だけある)
  const distance = new Map<string, number>();
  for (const r of rows) {
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

/**
 * 読む行グループ: bigram g の行が入りうるもの。cityCodes を渡すと、その市区町村の行が入りうるものだけ。
 * 統計の最小・最大はコードポイント順なので、UTF-16 の順になる演算子 (<=) では比べない
 */
const groupsFor = (file: ParquetFile, g: string, cityCodes?: ReadonlySet<string>): number[] => {
  const gs = columnStats(file.metadata, "g");
  const ls = columnStats(file.metadata, "lg_code");
  return gs.flatMap((s, i) =>
    compareCodePoints(s.min, g) <= 0 &&
    compareCodePoints(g, s.max) <= 0 &&
    (cityCodes === undefined || [...cityCodes].some((c) => ls[i].min <= c && c <= ls[i].max))
      ? [i]
      : [],
  );
};

export const forward = async (
  bucket: R2Bucket,
  prefix: string,
  input: Input,
  log: ReadLog = { reads: 0, bytes: 0 },
): Promise<Answer> => {
  const name = nfkc(input.name);
  const lf = legalForm(name);
  const core = coreName(name);
  const grams = bigrams(core);
  const shards = [...new Set(grams.map((g) => shardOf(g, SHARDS)))];
  const key = (dir: string, k: number) =>
    `${prefix}${dir}/shard=${String(k).padStart(4, "0")}.parquet`;

  // 1 回目: bigram の df、索引のフッター、市区町村の一覧を同時に読む。
  // 番号のファイルが無いのは、その番号の bigram を持つ法人が無いとき (export_parquet.py)
  const [gramRows, files, cityRows] = await Promise.all([
    Promise.all(shards.map((k) => readWhole<Gram>(bucket, key("gram", k), log))),
    Promise.all(
      shards.map(async (k) => [k, await openFile(bucket, key("posting", k), log)] as const),
    ),
    readWhole<City>(bucket, `${prefix}city.parquet`, log),
  ]);
  if (!cityRows) throw new Error(`not found: ${prefix}city.parquet`);
  const cities = cityRows;
  const wanted = new Set(grams);
  const chosen = gramRows
    .flatMap((r) => r ?? [])
    .filter((r) => wanted.has(r.g))
    .map((r) => ({ ...r, df: Number(r.df) }))
    .sort((a, b) => a.df - b.df || (a.g < b.g ? -1 : 1))
    .slice(0, RAREST_GRAMS)
    .reduce<{ total: number; list: (Gram & { full: boolean })[] }>(
      ({ total, list }, r) => ({
        total: total + r.df,
        // 最も珍しい bigram は必ず全国で読む (住所が無くても、同じ商号の法人をすべて引けるように)
        list: [...list, { ...r, full: list.length === 0 || total + r.df <= NATIONAL_READ_ROWS }],
      }),
      { total: 0, list: [] },
    ).list;
  const idf = new Map(chosen.map((r) => [r.g, r.idf]));
  const inCity = input.address ? citiesIn(nfkc(input.address), cities) : [];
  const cityCodes = new Set(inCity.map((c) => c.lg_code));
  const fileOf = new Map(files.flatMap(([k, f]) => (f ? [[k, f] as const] : [])));

  // 2 回目: 全国で読む bigram は全部の行、残りは住所の市区町村の行だけを読む。
  // 同じファイルの bigram は行グループをまとめ、同じ行グループを 2 回読まない
  const reads = chosen.filter((r) => r.full || cityCodes.size > 0);
  const byFile = Map.groupBy(reads, (r) => shardOf(r.g, SHARDS));
  const rows = (
    await Promise.all(
      [...byFile].map(async ([k, gs]) => {
        const file = fileOf.get(k);
        if (!file) return [];
        const groups = [
          ...new Set(gs.flatMap((r) => groupsFor(file, r.g, r.full ? undefined : cityCodes))),
        ].sort((a, b) => a - b);
        const got = await readGroups<Posting>(file, groups, [
          "g",
          "lg_code",
          "corporate_number",
          "legal_form",
          "core",
          "name",
        ]);
        const want = new Map(gs.map((r) => [r.g, r.full]));
        return got.filter((p) => {
          const full = want.get(p.g);
          return full !== undefined && (full || cityCodes.has(p.lg_code));
        });
      }),
    )
  ).flat();

  const fullGrams = new Set(chosen.filter((r) => r.full).map((r) => r.g));
  const national = topByScore(
    rows.filter((p) => fullGrams.has(p.g)),
    idf,
    core,
  );
  const local = topByScore(
    rows.filter((p) => cityCodes.has(p.lg_code)),
    idf,
    core,
  );
  const scores = new Map(
    [...national, ...local].map(([cn]) => [
      cn,
      Math.max(national.get(cn) ?? 0, local.get(cn) ?? 0),
    ]),
  );
  const byNumber = new Map(rows.map((p) => [p.corporate_number, p]));
  const legalOk = (p: Posting) => lf === null || lf === p.legal_form;

  const ranked = [...scores]
    .flatMap(([cn, score]) => {
      const p = byNumber.get(cn);
      if (!p) return [];
      const ed = levenshtein(core, p.core);
      const cityOk = cityCodes.has(p.lg_code);
      return [{ p, score, ed, cityOk, legal: legalOk(p) }];
    })
    .sort(
      (a, b) =>
        a.ed + (a.cityOk ? 0 : 2) - (b.ed + (b.cityOk ? 0 : 2)) ||
        a.ed - b.ed ||
        Number(b.legal) - Number(a.legal) ||
        b.score - a.score ||
        a.p.corporate_number.localeCompare(b.p.corporate_number),
    );

  // 同じ商号の法人の数。商号が同じ法人はどの bigram も持つので、全国で読んだ最も珍しい bigram の行で数える
  const rarest = chosen[0];
  const sameName = (p: Posting) => p.g === rarest?.g && p.core === core && legalOk(p);
  const sameCount =
    rarest === undefined
      ? null
      : rows.filter((p) => sameName(p) && (cityCodes.size === 0 || cityCodes.has(p.lg_code)))
          .length;

  const top = ranked[0];
  // 住所の市区町村が分かるときは、市区町村まで一致して初めて商号の一致とみなす
  const exact =
    top !== undefined && top.ed === 0 && top.legal && (cityCodes.size === 0 || top.cityOk);
  const status: Status = exact
    ? sameCount === 1
      ? "matched"
      : "ambiguous"
    : ranked.length > 0
      ? "candidates"
      : "not_found";

  const cityOf = new Map(cities.map((c) => [c.lg_code, c]));
  const limit = input.limit ?? 5;
  return {
    status,
    same_name_count: sameCount,
    candidates: ranked.slice(0, limit).map(({ p, ed, cityOk }) => ({
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
