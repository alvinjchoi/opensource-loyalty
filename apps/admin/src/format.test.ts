import { describe, expect, it } from "vitest";
import { formatNumber, memberName, percentage } from "./format.js";

describe("Admin formatting", () => {
  it("formats points, member fallbacks, and basis points", () => {
    expect(formatNumber(12_380)).toBe("12,380");
    expect(memberName({ name: "Maya Chen" }, "member-1")).toBe("Maya Chen");
    expect(memberName({}, "member-1")).toBe("member-1");
    expect(percentage(12_000)).toBe("120%");
  });
});
