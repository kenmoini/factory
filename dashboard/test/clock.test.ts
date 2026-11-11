import { describe, expect, test } from "bun:test";
import { formatAgo, formatElapsed } from "../web/lib/clock";
const now = Date.parse("2026-11-10T12:00:00Z");
describe("formatAgo", () => {
  test("buckets", () => {
    expect(formatAgo("2026-11-10T11:59:30Z", now)).toBe("now");
    expect(formatAgo("2026-11-10T11:48:00Z", now)).toBe("12m");
    expect(formatAgo("2026-11-10T09:00:00Z", now)).toBe("3h");
    expect(formatAgo("2026-11-08T12:00:00Z", now)).toBe("2d");
    expect(formatAgo("2026-10-01T12:00:00Z", now)).toBe("2026-10-01");
    expect(formatAgo("nope", now)).toBe("");
  });
  test("formatElapsed still works", () => { expect(formatElapsed(61_000)).toBe("01:01"); });
});
