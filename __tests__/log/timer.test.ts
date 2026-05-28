import { describe, it, expect } from "vitest";
import { Timer } from "../../src/log/timer.js";

describe("Timer", () => {
  it("returns a non-negative elapsed value after a setImmediate tick", async () => {
    const t = new Timer();
    await new Promise((r) => setImmediate(r));
    const elapsed = t.elapsedMs();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    // Sanity bound — should never take a full second on any reasonable host.
    expect(elapsed).toBeLessThan(1000);
  });

  it("returns 0 (or close to it) when measured immediately", () => {
    const t = new Timer();
    const elapsed = t.elapsedMs();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(50);
  });
});
