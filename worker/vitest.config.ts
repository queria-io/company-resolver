import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type Plugin } from "vitest/config";

const FIXTURE_DIR = join(import.meta.dirname, "test/fixture");
const MODULE_ID = "virtual:index-fixture";

/** テストの索引 (test/fixture/ の Parquet) を { 相対パス: ArrayBuffer } として import できるようにする */
const indexFixture: Plugin = {
  name: "index-fixture",
  resolveId: (id) => (id === MODULE_ID ? `\0${MODULE_ID}` : null),
  load(id) {
    if (id !== `\0${MODULE_ID}`) return null;
    const files = readdirSync(FIXTURE_DIR, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".parquet"))
      .map((f) => [
        relative(FIXTURE_DIR, join(FIXTURE_DIR, f)),
        readFileSync(join(FIXTURE_DIR, f)).toString("base64"),
      ]);
    const entries = files
      .map(
        ([path, b64]) =>
          `${JSON.stringify(path)}: Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)).buffer`,
      )
      .join(",\n");
    return `export default {${entries}};`;
  },
};

export default defineConfig({
  test: { exclude: ["bench/**", "node_modules/**"] },
  plugins: [indexFixture, cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
