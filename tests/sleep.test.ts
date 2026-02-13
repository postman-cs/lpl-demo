import { describe, it, expect } from "vitest";
import { sleep } from "../src/lib/sleep";

describe("sleep", () => {
  it("resolves after given ms", async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});
