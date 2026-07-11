/**
 * Abstract interface for key-value / stream / hash / sorted-set storage.
 * Implemented by RedisClient (src/redis.ts) and any future adapters.
 */
export interface DataStore {
  // Key-value
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  // Streams
  xadd(stream: string, id: string, fields: Record<string, string>): Promise<string>;
  xread(streams: string[], ids: string[], count?: number, blockMs?: number): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xlen(stream: string): Promise<number>;
  // Hash
  hget(hash: string, field: string): Promise<string | null>;
  hgetall(hash: string): Promise<Record<string, string>>;
  hset(hash: string, field: string, value: string): Promise<number>;
  hdel(hash: string, ...fields: string[]): Promise<number>;
  // Sorted set
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  // Pub/sub and expiry
  expire(key: string, seconds: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}
