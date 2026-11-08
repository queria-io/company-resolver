// cloudflare:test の型に、この Worker のバインディングを与える
declare namespace Cloudflare {
  interface Env {
    DATA: R2Bucket;
    INDEX_PREFIX: string;
  }
}

declare module "virtual:index-fixture" {
  /** test/fixture/ の Parquet。キーは test/fixture/ からの相対パス */
  const files: Record<string, ArrayBuffer>;
  export default files;
}
