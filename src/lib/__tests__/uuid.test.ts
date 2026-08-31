import { describe, expect, it } from "vitest";
import { randomUuid } from "@/lib/uuid";

describe("randomUuid", () => {
  it("returns unique RFC 4122 v4-shaped identifiers", () => {
    const first = randomUuid();
    const second = randomUuid();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second).not.toBe(first);
  });
});
