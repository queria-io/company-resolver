import { describe, expect, it } from "vitest";

import { loadIndex } from "../src/source";

const ID = "019a3c4e-7b21-7f3a-9c55-2f0d8e1a4b6c";

/** prefix の下に、1 つのバージョンを main が指す FDL のデータセットを置いた R2 */
const dataset = (prefix: string, table: object): R2Bucket => {
  const files: Record<string, string> = {
    [`${prefix}fdl.json`]: JSON.stringify({ fdl: "0.1", data_dir: "tables/" }),
    [`${prefix}refs/heads/main`]: `${ID}\n`,
    [`${prefix}versions/${ID}/version.json`]: JSON.stringify({
      fdl: "0.1",
      id: ID,
      tables: { path: "tables.json" },
    }),
    [`${prefix}versions/${ID}/tables.json`]: JSON.stringify({
      tables: { "reverse.company": table },
    }),
  };
  return {
    get: async (key: string) => (key in files ? new Response(files[key]) : null),
  } as unknown as R2Bucket;
};

describe("loadIndex", () => {
  it("main が指すバージョンの tables.json からファイルを引く", async () => {
    const files = [{ path: "reverse/company/a.parquet", rows: 1, bytes: 10, footer_bytes: 2 }];
    expect(await loadIndex(dataset("r/", { files }), "r/")).toMatchObject({
      version: ID,
      tables: {
        "reverse.company": [
          { key: "tables/reverse/company/a.parquet", rows: 1, bytes: 10, footerBytes: 2 },
        ],
      },
    });
  });

  it("削除ファイルも引く (読むときに削除した行を除く)", async () => {
    const deletes = { path: "d.parquet", rows: 1, bytes: 1 };
    const files = [{ path: "a.parquet", rows: 1, bytes: 10, deletes }];
    expect(await loadIndex(dataset("s/", { files }), "s/")).toMatchObject({
      tables: {
        "reverse.company": [{ key: "tables/a.parquet", deletes: { key: "tables/d.parquet" } }],
      },
    });
  });
});
