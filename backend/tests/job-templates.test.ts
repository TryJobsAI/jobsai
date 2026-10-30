import { describe, expect, test } from "bun:test";
import { createJobInputSchema, jobCategories } from "../src/job-input.js";
import { jobQualityInputSchema, scoreJobBrief } from "../src/job-quality.js";
import { jobTemplates } from "../src/job-templates.js";

const now = new Date("2026-10-30T12:00:00Z");
const fillPlaceholders = (value: string) => value.replace(/\[[^\]]+\]/g, "Acme 12");

describe("job templates", () => {
  test("have unique ids and valid categories and fit the job input limits", () => {
    expect(new Set(jobTemplates.map((template) => template.id)).size).toBe(jobTemplates.length);
    for (const template of jobTemplates) {
      expect(jobCategories).toContain(template.category);
      expect(createJobInputSchema.safeParse({ ...template, asset: "usdg", amount: "10" }).success).toBe(true);
    }
  });

  test("are flagged until their placeholders are replaced", () => {
    for (const template of jobTemplates) {
      const report = scoreJobBrief(jobQualityInputSchema.parse(template), now);
      expect(report.checks.find((item) => item.id === "placeholders")!.passed).toBe(false);
    }
  });

  test("score as strong once filled in with a deadline", () => {
    for (const template of jobTemplates) {
      const report = scoreJobBrief(jobQualityInputSchema.parse({
        title: fillPlaceholders(template.title),
        description: fillPlaceholders(template.description),
        acceptanceCriteria: template.acceptanceCriteria.map(fillPlaceholders),
        deadlineAt: "2026-11-06T12:00:00Z",
      }), now);
      expect({ id: template.id, failed: report.checks.filter((item) => !item.passed).map((item) => item.id) }).toEqual({ id: template.id, failed: [] });
      expect(report.grade).toBe("strong");
    }
  });
});
