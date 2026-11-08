// D1 の正引きの計測用 Worker (README.md)。build.py の出力先を out/ にしてからデプロイする
import cities from "./out/city.json";
import { forwardD1, type Sql } from "./forward-d1";

type Env = { DB: D1Database };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name")?.trim();
    if (url.pathname !== "/v1/forward" || !name) return new Response("not found", { status: 404 });
    let d1Ms = 0;
    const sql: Sql = async (statements) => {
      const results = await env.DB.batch(
        statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)),
      );
      d1Ms = Math.max(...results.map((r) => r.meta.duration));
      return results.map((r) => r.results);
    };
    const t0 = Date.now();
    const answer = await forwardD1(sql, cities, {
      name,
      address: url.searchParams.get("address")?.trim() || undefined,
    });
    return Response.json(answer, {
      headers: {
        "access-control-allow-origin": "*",
        // Worker の中で測った D1 の往復の時間と、D1 の中の実行時間 (ms)
        "x-wall-ms": String(Date.now() - t0),
        "x-d1-ms": String(d1Ms),
      },
    });
  },
};
