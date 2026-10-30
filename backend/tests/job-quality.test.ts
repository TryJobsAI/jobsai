import { describe, expect, test } from "bun:test";
import { jobQualityInputSchema, scoreJobBrief } from "../src/job-quality.js";

const now = new Date("2026-10-30T12:00:00Z");
const strongBrief = {
  title: "Translate a two-page restaurant menu into Spanish",
  description: "Translate our dinner menu from English into Spanish for Spanish-speaking guests. I will provide the current menu as a PDF and a list of dish names that must stay in English. Keep prices and allergen notes exactly as they are. Deliver the translation as an editable Google Doc that mirrors the original section order.",
  acceptanceCriteria: ["Includes every dish and section from the original menu", "Prices and allergen notes are unchanged", "Delivered as an editable Google Doc", "Dish names on the provided list stay in English"],
  deadlineAt: "2026-11-05T12:00:00Z",
};

describe("job brief quality score", () => {
  test("rates a specific, checkable brief as strong with no fixes", () => {
    const report = scoreJobBrief(jobQualityInputSchema.parse(strongBrief), now);
    expect(report.score).toBe(100);
    expect(report.grade).toBe("strong");
    expect(report.checks.every((item) => item.passed && item.fix === null)).toBe(true);
  });

  test("flags a thin brief and explains what to add", () => {
    const report = scoreJobBrief(jobQualityInputSchema.parse({ title: "Logo", description: "Need a logo ASAP, high quality, make it pop.", acceptanceCriteria: ["Looks good"] }), now);
    expect(report.grade).toBe("needs_work");
    expect(report.score).toBeLessThan(50);
    const failed = Object.fromEntries(report.checks.filter((item) => !item.passed).map((item) => [item.id, item.fix]));
    expect(Object.keys(failed)).toEqual(["title", "description", "deliverable", "inputs", "criteria_count", "criteria_measurable", "vague", "deadline"]);
    expect(report.checks.find((item) => item.id === "placeholders")!.passed).toBe(true);
    expect(failed.vague).toContain("\"high quality\"");
    expect(failed.criteria_count).toContain("at least 3");
  });

  test("gives partial credit and ignores past deadlines", () => {
    const report = scoreJobBrief(jobQualityInputSchema.parse({
      ...strongBrief,
      acceptanceCriteria: ["Includes every dish", "Feels natural"],
      deadlineAt: "2026-10-01T00:00:00Z",
    }), now);
    const byId = Object.fromEntries(report.checks.map((item) => [item.id, item]));
    expect(byId.criteria_count.earned).toBe(10);
    expect(byId.criteria_measurable.earned).toBe(8);
    expect(byId.deadline.earned).toBe(0);
    expect(report.grade).toBe("okay");
  });

  test("caps a brief with unfilled template placeholders", () => {
    const report = scoreJobBrief(jobQualityInputSchema.parse({ ...strongBrief, title: "Translate my [document type] into Spanish" }), now);
    const placeholders = report.checks.find((item) => item.id === "placeholders")!;
    expect(placeholders.passed).toBe(false);
    expect(placeholders.fix).toContain("[document type]");
    expect(report.score).toBe(45);
    expect(report.grade).toBe("needs_work");
  });

  test("accepts an empty draft and scores it as needing work", () => {
    const report = scoreJobBrief(jobQualityInputSchema.parse({}), now);
    expect(report.score).toBe(10);
    expect(report.grade).toBe("needs_work");
  });
});
