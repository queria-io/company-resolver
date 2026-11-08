import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import fixtures from "virtual:index-fixture";

import app from "../src/index";

beforeAll(async () => {
  await Promise.all(
    Object.entries(fixtures).map(([path, data]) => env.DATA.put(env.INDEX_PREFIX + path, data)),
  );
});

const reverse = (corporateNumber: string) =>
  app.request(`/v1/reverse?${new URLSearchParams({ corporate_number: corporateNumber })}`, {}, env);

describe("/v1/reverse", () => {
  it("法人番号から法人を返す", async () => {
    const res = await reverse("1000000000003");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      corporate_number: "1000000000003",
      name: "株式会社クエリア",
      furigana: null,
      kind: "301",
      prefecture: "広島県",
      city: "府中市",
      street_number: "1-1",
      lg_code: "342084",
      assignment_date: "2015-10-05",
    });
  });

  it("無い法人番号は 404", async () => {
    expect((await reverse("1000000000009")).status).toBe(404);
    expect((await reverse("1000000000099")).status).toBe(404);
  });

  it("13 桁の数字でなければ 400", async () => {
    expect((await reverse("123")).status).toBe(400);
    expect((await app.request("/v1/reverse", {}, env)).status).toBe(400);
  });
});
