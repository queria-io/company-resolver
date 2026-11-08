import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import fixtures from "virtual:index-fixture";

import app from "../src/index";
import type { Answer } from "../src/resolve";

beforeAll(async () => {
  await Promise.all(
    Object.entries(fixtures).map(([path, data]) => env.DATA.put(env.INDEX_PREFIX + path, data)),
  );
});

const resolve = async (query: Record<string, string>): Promise<Answer> => {
  const res = await app.request(`/v1/resolve?${new URLSearchParams(query)}`, {}, env);
  expect(res.status).toBe(200);
  return res.json();
};

describe("/v1/resolve", () => {
  it("商号と住所の市区町村で 1 件に決まれば matched", async () => {
    const answer = await resolve({
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
    const answer = await resolve({ name: "株式会社クエリア" });
    expect(answer.status).toBe("ambiguous");
    expect(answer.same_name_count).toBe(3);
  });

  it("同じ名前の市は都道府県で区別する", async () => {
    const answer = await resolve({ name: "株式会社クエリア", address: "広島県府中市府川町" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].corporate_number).toBe("1000000000003");
  });

  it("小書きの仮名と法人格の略記は正規化して一致させる", async () => {
    const answer = await resolve({ name: "(株)キャリアバンク", address: "東京都中央区" });
    expect(answer.status).toBe("matched");
    expect(answer.candidates[0].evidence.name).toBe("normalized");
  });

  it("法人格が違えば一致とせず、候補として返す", async () => {
    const answer = await resolve({ name: "合同会社クエリア", address: "東京都千代田区" });
    expect(answer.status).toBe("candidates");
    expect(answer.candidates[0].evidence.legal_form).toBe("mismatch");
  });

  it("誤字があれば候補として返し、何文字違いかを示す", async () => {
    const answer = await resolve({ name: "株式会社クエア", address: "東京都千代田区" });
    expect(answer.status).toBe("candidates");
    expect(answer.candidates[0]).toMatchObject({
      corporate_number: "1000000000001",
      evidence: { name: "edit(1)", city: "exact" },
    });
  });

  it("どの bigram も無ければ not_found", async () => {
    const answer = await resolve({ name: "存在しない名前" });
    expect(answer).toEqual({ status: "not_found", same_name_count: null, candidates: [] });
  });

  it("name が無ければ 400", async () => {
    const res = await app.request("/v1/resolve", {}, env);
    expect(res.status).toBe(400);
  });
});
