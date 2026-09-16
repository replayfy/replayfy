import { PrismaClient } from "../client";

export * from "../client";
export { PrismaClient };

let cached: PrismaClient | undefined;

export function getMongoClient(): PrismaClient {
  if (!cached) {
    cached = new PrismaClient({
      log:
        process.env.PRISMA_LOG === "1"
          ? ["query", "info", "warn", "error"]
          : ["warn", "error"],
    });
  }
  return cached;
}

export async function disconnectMongo(): Promise<void> {
  if (cached) {
    await cached.$disconnect();
    cached = undefined;
  }
}
