import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { assetFiles, rowReader } from "../src/assets";
import { forward as forwardOf, loadCities, type Rule } from "../src/forward";
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

describe("照合の規則を外したとき (bench/ablate.ts)", () => {
  const run = async (name: string, address: string, off: Rule[]) => {
    const read = rowReader(assetFiles(env.ASSETS), { reads: 0, bytes: 0 });
    return forwardOf(read, await loadCities(read), { name, address }, new Set(off));
  };

  it("exact_first を外しても、近い商号の検索で同じ条件の法人が 1 件なら matched", async () => {
    const answer = await run("株式会社クエリア", "東京都千代田区紀尾井町1-3", ["exact_first"]);
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].corporate_number).toBe("1000000000001");
  });

  it("city_match を外しても、matched の法人を 1 位に並べる", async () => {
    const legal = await run("有限会社クエリア", "東京都千代田区", ["city_match"]);
    expect(legal.status).toBe("matched");
    expect(legal.candidates[0].corporate_number).toBe("1000000000005");
  });
});

describe("/v1/forward の部局の名前 (parent_body)", () => {
  it("国の機関の部局は、親の機関に照合する", async () => {
    const answer = await forward({ name: "国土交通省関東地方整備局" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0]).toMatchObject({
      corporate_number: "1000000000101",
      evidence: { name: "parent" },
    });
  });

  it("先頭が同じ地方公共団体の名前の会社ではなく、地方公共団体に照合する", async () => {
    const answer = await forward({ name: "茨城県土浦土木事務所", address: "茨城県土浦市" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].corporate_number).toBe("1000000000201");
  });

  it("都道府県名を付けた市区町村の部局も照合する", async () => {
    const answer = await forward({ name: "東京都千代田区役所" });
    expect(answer.candidates[0].corporate_number).toBe("1000000000204");
  });

  it("同じ名前の地方公共団体は、住所の市区町村で絞る", async () => {
    const without = await forward({ name: "府中市役所" });
    expect(without.status).toBe("ambiguous");
    expect(without.same_name_count).toBe(2);
    const withAddress = await forward({ name: "府中市役所", address: "広島県府中市府川町" });
    expect(withAddress.status).toBe("matched");
    expect(withAddress.candidates[0].corporate_number).toBe("1000000000203");
  });

  it("商号の末尾が入力と同じ法人があれば、親の機関に寄せない", async () => {
    const answer = await forward({ name: "茨城県立大学" });
    expect(answer.candidates[0].corporate_number).toBe("1000000000012");
    expect(answer.candidates[0].evidence.name).not.toBe("parent");
  });

  it("入力に法人格があれば、親の機関に寄せない", async () => {
    const answer = await forward({ name: "株式会社茨城県土浦土木" });
    expect(answer.candidates.map((c) => c.evidence.name)).not.toContain("parent");
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
