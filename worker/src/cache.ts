export function siteCacheTag(address: string): string {
  return `nzip-site-${address}`;
}

/** Purge every cached URL for a site after content or policy changes. */
export async function purgeSiteCache(
  ctx: ExecutionContext,
  address: string,
): Promise<void> {
  if (!ctx.cache) return;

  try {
    const result = await ctx.cache.purge({ tags: [siteCacheTag(address)] });
    if (!result.success) {
      console.error({
        event: "cache.purge_failed",
        address,
        errors: result.errors,
      });
    }
  } catch (error) {
    console.error({
      event: "cache.purge_failed",
      address,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
