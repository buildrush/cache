// Debug-logging shim over @actions/core. Routes debug() either to the runner's
// hidden debug channel (default) or, when verbose mode is on, to the always-
// visible info channel — so `verbose: true` surfaces internal diagnostics in
// the step log without requiring the runner's ACTIONS_STEP_DEBUG secret.
//
// Verbose is resolved once at action startup (resolveVerbose) and latched via
// setVerbose; debug() callers anywhere in the codebase read the latched flag.
//
// SECURITY: never pass secrets to debug(). Tokens and signed upload/download
// URLs must never reach the log — verbose or not (see CONTRIBUTING "Code style").

import * as core from "@actions/core";

let verboseEnabled = false;

/**
 * Resolve verbose mode from the `verbose` action input, falling back to the
 * BUILDRUSH_CACHE_VERBOSE env var (the same env-config channel as
 * BUILDRUSH_CACHE_URL). Either set to "true" enables it. Uses getInput rather
 * than getBooleanInput so an absent input resolves to false instead of throwing.
 */
export function resolveVerbose(): boolean {
  const fromInput = core.getInput("verbose").trim().toLowerCase() === "true";
  const fromEnv = process.env.BUILDRUSH_CACHE_VERBOSE === "true";
  return fromInput || fromEnv;
}

/** Latch verbose mode for the lifetime of the action run. */
export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

/** Whether verbose mode is currently enabled. */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/**
 * Debug-level log. Hidden by default (core.debug — shown only under the
 * runner's step-debug); routed to the visible info channel with a `[debug]`
 * prefix when verbose mode is on. Never pass secrets — see the file header.
 */
export function debug(message: string): void {
  if (verboseEnabled) core.info(`[debug] ${message}`);
  else core.debug(message);
}
