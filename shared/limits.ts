/**
 * Maximum number of distinct R2 blobs a manifest may reference.
 *
 * The ceiling leaves headroom beneath the Workers Free internal-subrequest
 * limit for manifest storage and D1 operations during prepare and commit.
 */
export const MAX_UNIQUE_BLOBS = 900;

/**
 * Maximum size of one uploaded blob, in bytes (`50 MiB`).
 *
 * Both the CLI and Worker enforce this before retaining or buffering a body.
 */
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;
