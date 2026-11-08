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
  it("法人番号から法人と、旧商号・旧所在地を返す", async () => {
    const res = await reverse("1000000000001");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      corporate_number: "1000000000001",
      status: "active",
      name: "株式会社クエリア",
      furigana: null,
      kind: "301",
      prefecture: "東京都",
      city: "千代田区",
      street_number: "1-1",
      lg_code: "131016",
      assignment_date: "2015-10-05",
      close_date: null,
      close_cause: null,
      successor_corporate_number: null,
      former_names: [],
      former_addresses: [
        {
          prefecture: "東京都",
          city: "千代田区",
          street_number: "1-1",
          lg_code: "131016",
          until: "2020-04-01",
        },
        {
          prefecture: "東京都",
          city: "中央区",
          street_number: "2-2",
          lg_code: "131024",
          until: "2022-04-01",
        },
      ],
    });
  });

  it("閉鎖した法人は status を closed にし、閉鎖日と承継先を返す", async () => {
    const company = await (await reverse("1000000000009")).json();
    expect(company).toMatchObject({
      status: "closed",
      close_date: "2023-01-01",
      close_cause: "11",
      successor_corporate_number: "1000000000001",
      former_names: [{ name: "クエリア工業株式会社", until: "2023-01-01" }],
    });
  });

  it("無い法人番号は 404", async () => {
    expect((await reverse("1000000000010")).status).toBe(404);
    expect((await reverse("1000000000099")).status).toBe(404);
  });

  it("13 桁の数字でなければ 400", async () => {
    expect((await reverse("123")).status).toBe(400);
    expect((await app.request("/v1/reverse", {}, env)).status).toBe(400);
  });
});
