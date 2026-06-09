// Action runtime state shared between the restore (main) and save (post)
// steps via @actions/core's saveState/getState (the GITHUB_STATE file).

/**
 * Key under which the restore step records the cache key it matched
 * (`hit.matchedKey`). The save post-action reads it and skips re-saving when it
 * equals the primary key — an exact primary-key hit needs no re-upload. This
 * mirrors actions/cache@v5, which never saves on an exact primary-key match. A
 * prefix / restore-key / cross-ref hit records a key that differs from the
 * primary key, so those still save (the standard "restore old, save new"
 * upgrade path).
 */
export const STATE_CACHE_MATCHED_KEY = "BR_CACHE_MATCHED_KEY";
