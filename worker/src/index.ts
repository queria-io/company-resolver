// 法人名寄せ API。正引きは企業名 (と住所) から法人番号の候補を、逆引きは法人番号から法人を返す。照合の規則は DESIGN.md
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import { type ReadLog } from "./parquet";
import { forward, forwardMany, type Input, loadCities, type Sql } from "./forward";
import { isCorporateNumber, reverse } from "./reverse";
import { loadIndex } from "./source";

export type Env = {
  /** 正引きの索引 (scripts/sync_d1.py が入れる) */
  DB: D1Database;
  /** 逆引きの索引 (Parquet) の置き場 */
  DATA: R2Bucket;
  /** 索引の置き場。FDL のリポジトリ (「…/」) か目録 (「….json」)。src/source.ts */
  DATA_SOURCE: string;
  /** IP ごとの回数の上限。テストでは無い */
  LIMITER?: RateLimit;
  /** IP ごとの、まとめて照合する回数の上限。テストでは無い */
  BATCH_LIMITER?: RateLimit;
};

const MAX_LIMIT = 20;
/**
 * まとめて照合する問い合わせの数の上限。D1 は 1 件ずつ順に処理し、10 秒のあいだに使った資源が多すぎると
 * しばらく問い合わせを断る (近い商号の検索を 1 秒に約 17 件、10 秒続けると断られた)。
 * 近い商号の検索が 20 件続いても約 1 秒で終わる数にする
 */
const MAX_BATCH = 20;
/** name の文字数の上限。D1 に渡す bigram の一覧と編集距離の計算は name の長さに比例するため、上限を置く */
const MAX_NAME_LENGTH = 200;
/** address の文字数の上限。住所から市区町村を探すのに、市区町村の数だけ address を走査するため */
const MAX_ADDRESS_LENGTH = 200;
/** /v1/forward/batch の本文の大きさの上限 (MAX_BATCH 件 × name と address の上限に余裕を足したもの) */
const MAX_BATCH_BODY_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

// D1 が混み合って断ったときは、少し待てば通るので 503 と Retry-After で返す
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (/overloaded/i.test(err.message)) {
    c.header("Retry-After", "10");
    return c.json({ error: "混み合っています。10 秒ほど待ってから呼んでください" }, 503);
  }
  console.error(err);
  return c.json({ error: "サーバーで問題が起きました" }, 500);
});

// ブラウザの DuckDB (Queria の resolve_company) からも呼ぶ
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));

// DuckDB の read_json は GET の前に HEAD を送る。HEAD では照合せずに答え、D1 を 2 回引かず、回数にも数えない
// (Hono は HEAD を GET の処理に回すので、元の要求のメソッドで見分ける)
const answerHead: MiddlewareHandler = async (c, next) =>
  c.req.raw.method === "HEAD" ? c.body(null, 200, { "content-type": "application/json" }) : next();
app.use("/v1/forward", answerHead);
app.use("/v1/forward/batch", answerHead);

// 鍵は呼んだ元の IP。上限は Cloudflare の拠点ごとに数えるので目安
app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  if (c.env.LIMITER && ip && !(await c.env.LIMITER.limit({ key: ip })).success) {
    return c.json({ error: "呼び出しが多すぎます。少し待ってから呼んでください" }, 429);
  }
  return next();
});

/** 問い合わせの検査。name は必須、limit は 1〜MAX_LIMIT に収める。誤りがあれば文言を返す */
const inputOf = (name: unknown, address: unknown, limit: unknown): Input | string => {
  if (typeof name !== "string" || name.trim() === "") return "name は必須です";
  if (Array.from(name.trim()).length > MAX_NAME_LENGTH) {
    return `name は ${MAX_NAME_LENGTH} 文字以内にしてください`;
  }
  if (address !== undefined && address !== null && typeof address !== "string") {
    return "address は文字列にしてください";
  }
  if (typeof address === "string" && Array.from(address.trim()).length > MAX_ADDRESS_LENGTH) {
    return `address は ${MAX_ADDRESS_LENGTH} 文字以内にしてください`;
  }
  return {
    name: name.trim(),
    address: address?.trim() || undefined,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(limit ?? 5) || 5)),
  };
};

/** D1 の batch。読んだ行数 (課金の単位) を足し合わせる */
const d1 = (db: D1Database) => {
  const log = { rowsRead: 0 };
  const sql: Sql = async (statements) => {
    const results = await db.batch(
      statements.map(({ sql, params }) => db.prepare(sql).bind(...params)),
    );
    log.rowsRead += results.reduce((n, r) => n + r.meta.rows_read, 0);
    return results.map((r) => r.results);
  };
  return { sql, log };
};

app.get("/v1/forward", async (c) => {
  const input = inputOf(c.req.query("name"), c.req.query("address"), c.req.query("limit"));
  if (typeof input === "string") return c.json({ error: input }, 400);
  const { sql, log } = d1(c.env.DB);
  const answer = await forward(sql, await loadCities(sql), input);
  // D1 から読んだ行数 (計測用)
  c.header("X-D1-Rows-Read", String(log.rowsRead));
  return c.json(answer);
});

/** まとめて照合する。応答の results は queries と同じ順で、それぞれに入力 (input) を付ける */
const forwardBatch = async (c: Context<{ Bindings: Env }>, queries: unknown) => {
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_BATCH) {
    return c.json({ error: `1〜${MAX_BATCH} 件の問い合わせを渡してください` }, 400);
  }
  const inputs: Input[] = [];
  // 応答の input は渡された値のまま返す (呼んだ側が元の表と結合できるように)
  const echoes: { name: string; address: string | null }[] = [];
  for (const [i, q] of queries.entries()) {
    if (typeof q !== "object" || q === null) {
      return c.json({ error: `queries[${i}]: 問い合わせはオブジェクトにしてください` }, 400);
    }
    const name = "name" in q ? q.name : undefined;
    const address = "address" in q ? q.address : undefined;
    const input = inputOf(name, address, "limit" in q ? q.limit : undefined);
    if (typeof input === "string") return c.json({ error: `queries[${i}]: ${input}` }, 400);
    inputs.push(input);
    echoes.push({
      name: String(name),
      address: typeof address === "string" && address !== "" ? address : null,
    });
  }
  // 回数は D1 を引く問い合わせだけ数える (誤りのある問い合わせで上限を使わせない)
  const ip = c.req.header("cf-connecting-ip");
  if (c.env.BATCH_LIMITER && ip && !(await c.env.BATCH_LIMITER.limit({ key: ip })).success) {
    return c.json({ error: "呼び出しが多すぎます。少し待ってから呼んでください" }, 429);
  }
  const { sql, log } = d1(c.env.DB);
  const answers = await forwardMany(sql, await loadCities(sql), inputs);
  c.header("X-D1-Rows-Read", String(log.rowsRead));
  return c.json({ results: answers.map((a, i) => ({ input: echoes[i], ...a })) });
};

// 本文の queries に問い合わせの配列を渡す
app.post(
  "/v1/forward/batch",
  bodyLimit({
    maxSize: MAX_BATCH_BODY_BYTES,
    onError: (c) => c.json({ error: "本文が大きすぎます" }, 413),
  }),
  async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    return forwardBatch(
      c,
      typeof body === "object" && body !== null && "queries" in body ? body.queries : undefined,
    );
  },
);

// URL だけで呼ぶ口 (DuckDB の read_json など)。name を繰り返して渡す。address は渡すなら name と同じ数だけ
// 同じ順に繰り返す (無い社は空)。limit はすべての問い合わせに効く
app.get("/v1/forward/batch", async (c) => {
  const names = c.req.queries("name") ?? [];
  const addresses = c.req.queries("address");
  if (addresses && addresses.length !== names.length) {
    return c.json({ error: "address は name と同じ数だけ渡してください" }, 400);
  }
  const limit = c.req.query("limit");
  return forwardBatch(
    c,
    names.map((name, i) => ({ name, address: addresses?.[i], limit })),
  );
});

app.get("/v1/reverse", async (c) => {
  const corporateNumber = c.req.query("corporate_number")?.trim() ?? "";
  if (!isCorporateNumber(corporateNumber)) {
    return c.json({ error: "corporate_number に 13 桁の法人番号を渡してください" }, 400);
  }
  const log: ReadLog = { reads: 0, bytes: 0 };
  const index = await loadIndex(c.env.DATA, c.env.DATA_SOURCE);
  const company = await reverse(c.env.DATA, index, corporateNumber, log);
  c.header("X-R2-Reads", String(log.reads));
  c.header("X-R2-Bytes", String(log.bytes));
  return company ? c.json(company) : c.json({ error: "法人番号が見つかりません" }, 404);
});

export default app;
