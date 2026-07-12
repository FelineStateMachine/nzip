import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";

const testEnv = env as Cloudflare.Env & {
  TEST_BASE_MIGRATIONS: D1Migration[];
  TEST_MIGRATIONS: D1Migration[];
};
await applyD1Migrations(testEnv.DB, testEnv.TEST_BASE_MIGRATIONS);
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
