// 索引のファイルを読む口。R2Bucket のうち get だけにして、ベンチマークでは手元のファイルに差し替える

type Range = { offset: number; length: number } | { suffix: number };
type Body = { size: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> };

/** R2Bucket のうち、索引を読むのに使う get だけ */
export type Store = { get(key: string, options?: { range?: Range }): Promise<Body | null> };
