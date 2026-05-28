import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";

const home = "/home/runner";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: vi.fn(() => home) };
});

const { expandHomeTilde } = await import("../../src/archive/paths.js");

describe("expandHomeTilde", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands `~/foo` to `<home>/foo`", () => {
    expect(expandHomeTilde(["~/foo"])).toEqual([path.join(home, "foo")]);
  });

  it("expands bare `~` to `<home>`", () => {
    expect(expandHomeTilde(["~"])).toEqual([home]);
  });

  it("expands nested `~/a/b/c` to `<home>/a/b/c`", () => {
    expect(expandHomeTilde(["~/a/b/c"])).toEqual([
      path.join(home, "a", "b", "c"),
    ]);
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHomeTilde(["/tmp/cache"])).toEqual(["/tmp/cache"]);
  });

  it("leaves relative paths unchanged", () => {
    expect(expandHomeTilde(["build/out"])).toEqual(["build/out"]);
  });

  it("leaves `~otheruser` unchanged (no passwd lookup)", () => {
    expect(expandHomeTilde(["~root/x"])).toEqual(["~root/x"]);
  });

  it("expands per-entry, mixing forms", () => {
    expect(
      expandHomeTilde(["~/.cache/go-build", "~/go/pkg/mod", "/abs/path"]),
    ).toEqual([
      path.join(home, ".cache/go-build"),
      path.join(home, "go/pkg/mod"),
      "/abs/path",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(expandHomeTilde([])).toEqual([]);
  });
});
