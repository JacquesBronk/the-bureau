import type { RedisClient } from "../redis.js";

const KEY_PREFIX = "bureau:img";

export interface CatalogEntry {
  image: string;
  approvedAt: number;
  approvedBy: string;
}

export class ImageCatalog {
  constructor(private readonly redis: RedisClient) {}

  async isApproved(image: string): Promise<boolean> {
    return (await this.redis.exists(`${KEY_PREFIX}:${image}`)) > 0;
  }

  async register(image: string, approvedBy: string): Promise<void> {
    await this.redis.hset(`${KEY_PREFIX}:${image}`, {
      image,
      approvedAt: Date.now().toString(),
      approvedBy,
    });
  }

  async list(): Promise<CatalogEntry[]> {
    const keys = await this.redis.keys(`${KEY_PREFIX}:*`);
    const entries: CatalogEntry[] = [];
    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data?.image) {
        entries.push({
          image: data.image,
          approvedAt: Number(data.approvedAt ?? 0),
          approvedBy: data.approvedBy ?? "unknown",
        });
      }
    }
    return entries;
  }

  async seedFromEnv(envValue: string | undefined): Promise<void> {
    if (!envValue) return;
    const images = envValue.split(",").map(s => s.trim()).filter(Boolean);
    for (const image of images) {
      await this.register(image, "system");
    }
  }
}
