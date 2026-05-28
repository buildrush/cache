import * as core from "@actions/core";
import { run } from "./main.js";

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`Unexpected error: ${msg}`);
});
