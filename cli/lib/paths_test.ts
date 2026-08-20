import { dirname, join } from "@std/path";
import { sourceRoot } from "./paths.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("sourceRoot treats a directory and its index.html as one logical source", async () => {
  const root = await Deno.makeTempDir();
  try {
    const index = join(root, "index.html");
    await Deno.writeTextFile(index, "<!doctype html>");

    assertEquals(sourceRoot(root), Deno.realPathSync(root));
    assertEquals(sourceRoot(index), Deno.realPathSync(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sourceRoot preserves another single-file source identity", async () => {
  const root = await Deno.makeTempDir();
  try {
    const page = join(root, "report.html");
    await Deno.writeTextFile(page, "<!doctype html>");
    assertEquals(sourceRoot(page), Deno.realPathSync(page));
    if (sourceRoot(page) === dirname(Deno.realPathSync(page))) {
      throw new Error("non-index file unexpectedly collapsed to its parent directory");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
