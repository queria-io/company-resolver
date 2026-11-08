// cloudflare:test の型に、この Worker のバインディングを与える
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    DATA: R2Bucket;
    DATA_SOURCE: string;
  }
}

declare module "virtual:index-fixture" {
  /** test/fixture/ の Parquet と目録。キーは test/fixture/ からの相対パス */
  const files: Record<string, ArrayBuffer>;
  export default files;
}
