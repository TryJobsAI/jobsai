import { describe, expect, test } from "bun:test";
import { amountSchema, assertMinimumJobAmount, createJobInputSchema, parseDeadline, parseJobAmount, submissionInputSchema } from "../src/job-input.js";

describe("job and submission input", () => {
  test("validates and normalizes job details", () => {
    const input = createJobInputSchema.parse({
      title: "  Build a dashboard  ", description: "  Build the requested dashboard. ",
      acceptanceCriteria: ["  Responsive layout  "], asset: "eth", amount: "0.25",
    });
    expect(input.title).toBe("Build a dashboard");
    expect(input.acceptanceCriteria).toEqual(["Responsive layout"]);
    expect(createJobInputSchema.safeParse({ ...input, title: "ok" }).success).toBe(false);
    expect(createJobInputSchema.safeParse({ ...input, asset: "usd" }).success).toBe(false);
    expect(amountSchema.safeParse("1e3").success).toBe(false);
    expect(amountSchema.safeParse("-1").success).toBe(false);
  });

  test("parses ETH and USDG at their own precision", () => {
    expect(parseJobAmount("eth", "0.000000000000000001", 6)).toBe(1n);
    expect(parseJobAmount("usdg", "12.345678", 6)).toBe(12_345_678n);
    expect(() => parseJobAmount("usdg", "0.0000001", 6)).toThrow("too many decimal places");
    expect(() => parseJobAmount("eth", "0", 18)).toThrow("greater than zero");
  });

  test("enforces each asset minimum without converting between assets", () => {
    const ethMinimum = parseJobAmount("eth", "0.001", 6);
    const usdgMinimum = parseJobAmount("usdg", "1", 6);
    expect(() => assertMinimumJobAmount(parseJobAmount("eth", "0.0009", 6), ethMinimum, "eth")).toThrow("minimum");
    expect(() => assertMinimumJobAmount(parseJobAmount("usdg", "0.99", 6), usdgMinimum, "usdg")).toThrow("minimum");
    expect(() => assertMinimumJobAmount(ethMinimum, ethMinimum, "eth")).not.toThrow();
    expect(() => assertMinimumJobAmount(usdgMinimum, usdgMinimum, "usdg")).not.toThrow();
  });

  test("validates submissions and future deadlines", () => {
    expect(submissionInputSchema.parse({ summary: "Done", deliverable: "https://example.com", evidence: [] }).evidence).toEqual([]);
    expect(submissionInputSchema.safeParse({ summary: "", deliverable: "x" }).success).toBe(false);
    const now = new Date("2030-01-01T00:00:00Z");
    expect(parseDeadline("2030-01-02T00:00:00Z", now)?.toISOString()).toBe("2030-01-02T00:00:00.000Z");
    expect(parseDeadline(undefined, now)).toBeNull();
    expect(() => parseDeadline("2029-12-31T00:00:00Z", now)).toThrow("future date");
    expect(() => parseDeadline("nonsense", now)).toThrow("future date");
  });
});
