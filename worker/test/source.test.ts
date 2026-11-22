import { describe, expect, it } from "vitest";

import { loadIndex, tablesFile } from "../src/source";

const bucket = (files: Record<string, string>): R2Bucket =>
  ({
    get: async (key: string) => (key in files ? new Response(files[key]) : null),
  }) as unknown as R2Bucket;

describe("loadIndex", () => {
  it("main が指すバージョンの tables.json からファイルを引く", async () => {
    const index = await loadIndex(
      bucket({
        "r/fdl.json": JSON.stringify({ data_dir: "tables/" }),
        "r/refs/heads/main": "v1\n",
        "r/versions/v1/version.json": JSON.stringify({ tables: { path: "tables.json" } }),
        "r/versions/v1/tables.json": JSON.stringify({
          tables: {
            "reverse.company": {
              files: [{ path: "reverse/company/a.parquet", bytes: 10, footer_bytes: 2 }],
            },
          },
        }),
      }),
      "r/",
    );
    expect(index).toEqual({
      version: "v1",
      tables: {
        "reverse.company": [{ key: "r/tables/reverse/company/a.parquet", bytes: 10, footer: 2 }],
      },
    });
  });
});

describe("tablesFile", () => {
  it("フォルダの外を指すものや無いものは読まない", () => {
    expect(tablesFile({ tables: { path: "tables.json" } })).toBe("tables.json");
    expect(() => tablesFile({ tables: { path: "../x.json" } })).toThrow();
    expect(() => tablesFile({})).toThrow();
  });
});
