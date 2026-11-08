// 法人名寄せ API。正引きは企業名 (と住所) から法人番号の候補を、逆引きは法人番号から法人を返す。照合の規則は DESIGN.md
import { Hono } from "hono";
import { cors } from "hono/cors";

import { type ReadLog } from "./parquet";
import { forward, loadCities, type Sql } from "./forward";
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
};

const MAX_LIMIT = 20;
/** name の文字数の上限。D1 に渡す bigram の一覧と編集距離の計算は name の長さに比例するため、上限を置く */
const MAX_NAME_LENGTH = 200;

const app = new Hono<{ Bindings: Env }>();

// ブラウザの DuckDB (Queria の resolve_company) からも呼ぶ
app.use("*", cors({ origin: "*", allowMethods: ["GET"] }));

// 鍵は呼んだ元の IP。上限は Cloudflare の拠点ごとに数えるので目安
app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  if (c.env.LIMITER && ip && !(await c.env.LIMITER.limit({ key: ip })).success) {
    return c.json({ error: "呼び出しが多すぎます。少し待ってから呼んでください" }, 429);
  }
  return next();
});

app.get("/v1/forward", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name) return c.json({ error: "name は必須です" }, 400);
  if (Array.from(name).length > MAX_NAME_LENGTH) {
    return c.json({ error: `name は ${MAX_NAME_LENGTH} 文字以内にしてください` }, 400);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(c.req.query("limit") ?? 5) || 5));
  // D1 の batch。読んだ行数 (課金の単位) を足し合わせる
  let rowsRead = 0;
  const sql: Sql = async (statements) => {
    const results = await c.env.DB.batch(
      statements.map(({ sql, params }) => c.env.DB.prepare(sql).bind(...params)),
    );
    rowsRead += results.reduce((n, r) => n + r.meta.rows_read, 0);
    return results.map((r) => r.results);
  };
  const answer = await forward(sql, await loadCities(sql), {
    name,
    address: c.req.query("address")?.trim() || undefined,
    limit,
  });
  // D1 から読んだ行数 (計測用)
  c.header("X-D1-Rows-Read", String(rowsRead));
  return c.json(answer);
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
