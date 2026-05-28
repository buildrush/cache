import * as core from "@actions/core";
import type { FallbackMode, ReasonCode } from "./types.js";

export const ANNOTATION_PREFIX = "Build_Rush Cache unavailable —";

export interface FallbackResult {
  shouldFail: boolean;
  disableCache: boolean;
}

export function applyFallback(
  mode: FallbackMode,
  reason: ReasonCode
): FallbackResult {
  switch (mode) {
    case "github":
      core.warning(
        `${ANNOTATION_PREFIX} falling back to GitHub cache (reason: ${reason})`
      );
      return { shouldFail: false, disableCache: false };
    case "skip":
      core.warning(
        `${ANNOTATION_PREFIX} caching skipped for this step (reason: ${reason})`
      );
      return { shouldFail: false, disableCache: true };
    case "fail":
      core.error(
        `${ANNOTATION_PREFIX} failing step (reason: ${reason})`
      );
      return { shouldFail: true, disableCache: false };
  }
}
