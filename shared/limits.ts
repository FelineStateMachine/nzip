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

/** Fallback lifetime in days for new sites whose vault does not define one. */
export const GLOBAL_DEFAULT_TTL = 14;

/** Maximum stored feedback items per site. Pages key notes by item, such as one per section. */
export const MAX_FEEDBACK_ITEMS = 200;

/** Maximum characters in one feedback note. */
export const MAX_FEEDBACK_TEXT = 4000;

/**
 * Feedback item keys: short, URL-safe identifiers chosen by the page, such as
 * `intro`, `option-3`, or `run:eval-2`.
 */
export const FEEDBACK_ITEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
