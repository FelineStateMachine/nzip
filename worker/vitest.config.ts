import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          NZIP_TOKEN: "runtime-test-token",
          PUBLIC_BASE: "https://share.demo.dev",
          SITE_DOMAIN: "demo.dev",
          TEST_BASE_MIGRATIONS: await readD1Migrations(
            "./test/base-migrations",
          ),
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/runtime.setup.ts"],
    include: ["./test/**/*.runtime.test.ts"],
  },
});
