# Project notes

This is a Deno project. Use Deno tasks and Deno-compatible tooling for CLI and shared-code work.

When revising HTML that was already shared, retain its existing URL. Untargeted `nzip site push`
reuses a unique breadcrumb for the same logical source; pass the prior target explicitly when the
source has multiple matches. Use `--new` only when a separate share was requested. Use `site push`
for content and `site policy` for TTL/password changes.
