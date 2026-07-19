import assert from "node:assert/strict";
import test from "node:test";

import { allocateAddress } from "../src/db.ts";

test("app reservations count as permanently occupied allocator slots", async () => {
  const addresses = Array.from({ length: 4096 }, (_, id) => ({ address: (15 << 12) | id }));
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return { all: async () => ({ results: addresses }) };
          },
        };
      },
    },
  };

  await assert.rejects(() => allocateAddress(env, 15), /vault is full/);
});
