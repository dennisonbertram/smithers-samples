import { describe, it, expect } from "bun:test";
import { slugify } from "./slugify.js";

describe("slugify", () => {
  it("lowercases the input", () => {
    expect(slugify("Hello")).toBe("hello");
  });

  it("replaces spaces with hyphens", () => {
    // BUG in src/slugify.ts: uses '+' instead of '-' for spaces
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(slugify("C++ is great!")).toBe("c-is-great");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  trim me  ")).toBe("trim-me");
  });
});
