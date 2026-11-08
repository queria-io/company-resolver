// 法人名寄せ API。企業名 (と住所) から法人番号の候補を返す。照合の規則は DESIGN.md
import { Hono } from "hono";

import { type ReadLog } from "./parquet";
import { resolve } from "./resolve";

export type Env = {
  DATA: R2Bucket;
  /** 索引の置き場 (R2 のプレフィックス) */
  INDEX_PREFIX: string;
};

const MAX_LIMIT = 20;

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/resolve", async (c) => {
  const name = c.req.query("name")?.trim();
  if (!name) return c.json({ error: "name は必須です" }, 400);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(c.req.query("limit") ?? 5) || 5));
  const log: ReadLog = { reads: 0, bytes: 0 };
  const answer = await resolve(
    c.env.DATA,
    c.env.INDEX_PREFIX,
    { name, address: c.req.query("address")?.trim() || undefined, limit },
    log,
  );
  // R2 の読み込み回数と量 (計測用)
  c.header("X-R2-Reads", String(log.reads));
  c.header("X-R2-Bytes", String(log.bytes));
  return c.json(answer);
});

export default app;
