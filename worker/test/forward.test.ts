import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import type { Answer } from "../src/forward";

const forward = async (query: Record<string, string>): Promise<Answer> => {
  const res = await app.request(`/v1/forward?${new URLSearchParams(query)}`, {}, env);
  expect(res.status).toBe(200);
  return res.json();
};

describe("/v1/forward", () => {
  it("商号と住所の市区町村で 1 件に決まれば matched", async () => {
    const answer = await forward({
      name: "株式会社クエリア",
      address: "東京都千代田区紀尾井町1-3",
    });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0]).toMatchObject({
      corporate_number: "1000000000001",
      evidence: { name: "exact", legal_form: "exact", city: "exact" },
    });
  });

  it("住所が無く同じ商号が複数あれば ambiguous で、その数を返す", async () => {
    const answer = await forward({ name: "株式会社クエリア" });
    expect(answer.status).toBe("ambiguous");
    expect(answer.same_name_count).toBe(3);
  });

  it("同じ名前の市は都道府県で区別する", async () => {
    const answer = await forward({ name: "株式会社クエリア", address: "広島県府中市府川町" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].corporate_number).toBe("1000000000003");
  });

  it("小書きの仮名と法人格の略記は正規化して一致させる", async () => {
    const answer = await forward({ name: "(株)キャリアバンク", address: "東京都中央区" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].evidence.name).toBe("normalized");
  });

  it("法人格が違えば一致とせず、候補として返す", async () => {
    const answer = await forward({ name: "合同会社クエリア", address: "東京都千代田区" });
    expect(answer.status).toBe("candidates");
    expect(answer.candidates[0].evidence.legal_form).toBe("mismatch");
  });

  it("商号が一致しても住所の市区町村が違えば、候補として返す", async () => {
    const answer = await forward({ name: "株式会社キャリアバンク", address: "大阪府大阪市北区" });
    expect(answer.status).toBe("candidates");
    expect(answer.candidates[0]).toMatchObject({
      corporate_number: "1000000000006",
      evidence: { name: "normalized", city: "mismatch" },
    });
  });

  it("誤字があれば候補として返し、何文字違いかを示す", async () => {
    const answer = await forward({ name: "株式会社クエア", address: "東京都千代田区" });
    expect(answer.status).toBe("candidates");
    expect(answer.candidates[0]).toMatchObject({
      corporate_number: "1000000000001",
      evidence: { name: "edit(1)", city: "exact" },
    });
  });

  it("どの bigram も無ければ not_found", async () => {
    const answer = await forward({ name: "存在しない名前" });
    expect(answer).toEqual({ status: "not_found", same_name_count: null, candidates: [] });
  });

  it("name が無ければ 400", async () => {
    const res = await app.request("/v1/forward", {}, env);
    expect(res.status).toBe(400);
  });

  it("name が長すぎれば 400", async () => {
    const res = await app.request(
      `/v1/forward?${new URLSearchParams({ name: "ア".repeat(201) })}`,
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it("読んだファイルの数をヘッダーで返す", async () => {
    const res = await app.request(
      `/v1/forward?${new URLSearchParams({ name: "株式会社クエリア" })}`,
      {},
      env,
    );
    expect(Number(res.headers.get("X-Asset-Reads"))).toBeGreaterThan(0);
  });

  it("商号が同じ法人で決まれば、bigram の索引は引かない", async () => {
    const rowsRead = async (query: Record<string, string>) =>
      Number(
        (await app.request(`/v1/forward?${new URLSearchParams(query)}`, {}, env)).headers.get(
          "X-Asset-Reads",
        ),
      );
    const exact = await rowsRead({ name: "株式会社クエリア", address: "東京都千代田区" });
    const fuzzy = await rowsRead({ name: "株式会社クエア", address: "東京都千代田区" });
    expect(exact).toBeLessThan(fuzzy);
  });
});

const batch = (body: unknown) =>
  app.request(
    "/v1/forward/batch",
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    env,
  );

describe("/v1/forward/batch", () => {
  it("問い合わせと同じ順に、1 件ずつの正引きと同じ応答を返す", async () => {
    const queries: Record<string, string>[] = [
      { name: "株式会社クエア", address: "東京都千代田区" },
      { name: "株式会社クエリア", address: "東京都千代田区紀尾井町1-3" },
      { name: "存在しない名前" },
      { name: "株式会社クエリア" },
    ];
    const res = await batch({ queries });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: (Answer & { input: unknown })[] };
    expect(results.map((r) => r.status)).toEqual([
      "candidates",
      "matched",
      "not_found",
      "ambiguous",
    ]);
    for (const [i, q] of queries.entries()) {
      expect(results[i]).toEqual({
        input: { name: q.name, address: q.address ?? null },
        ...(await forward(q)),
      });
    }
  });

  it("GET では name と address を繰り返して渡す", async () => {
    const params = new URLSearchParams([
      ["name", "株式会社クエリア"],
      ["address", "東京都千代田区紀尾井町1-3"],
      ["name", "株式会社クエア"],
      ["address", "東京都千代田区"],
    ]);
    const res = await app.request(`/v1/forward/batch?${params}`, {}, env);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: (Answer & { input: unknown })[] };
    expect(results.map((r) => [r.input, r.status])).toEqual([
      [{ name: "株式会社クエリア", address: "東京都千代田区紀尾井町1-3" }, "matched"],
      [{ name: "株式会社クエア", address: "東京都千代田区" }, "candidates"],
    ]);
  });

  it("HEAD では照合しない", async () => {
    const res = await app.request(
      `/v1/forward/batch?${new URLSearchParams({ name: "株式会社クエリア" })}`,
      { method: "HEAD" },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Asset-Reads")).toBeNull();
    const single = await app.request(
      `/v1/forward?${new URLSearchParams({ name: "株式会社クエリア" })}`,
      { method: "HEAD" },
      env,
    );
    expect(single.headers.get("X-Asset-Reads")).toBeNull();
  });

  it("GET で address の数が name と違えば 400", async () => {
    const params = new URLSearchParams([
      ["name", "クエリア"],
      ["name", "テスト"],
      ["address", "東京都"],
    ]);
    const res = await app.request(`/v1/forward/batch?${params}`, {}, env);
    expect(res.status).toBe(400);
  });

  it("問い合わせが 20 件を超えれば 400", async () => {
    const res = await batch({ queries: Array.from({ length: 21 }, () => ({ name: "クエリア" })) });
    expect(res.status).toBe(400);
  });

  it("name の無い問い合わせがあれば、その位置を示して 400", async () => {
    const res = await batch({ queries: [{ name: "クエリア" }, { address: "東京都" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("queries[1]");
  });

  it("address が長すぎれば 400", async () => {
    const res = await batch({ queries: [{ name: "クエリア", address: "東".repeat(201) }] });
    expect(res.status).toBe(400);
  });

  it("本文が大きすぎれば 413", async () => {
    const res = await batch({ queries: [{ name: "クエリア" }], padding: "x".repeat(100 * 1024) });
    expect(res.status).toBe(413);
  });

  it("本文が JSON でなければ 400", async () => {
    const res = await app.request("/v1/forward/batch", { method: "POST", body: "x" }, env);
    expect(res.status).toBe(400);
  });
});
