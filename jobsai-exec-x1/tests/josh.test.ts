import { describe, expect, test } from "bun:test";
import { assessCodeReviewFit, extractInlineSources, formatReview, isCodeReviewJob, parseGitHubRepoUrl } from "../src/josh.js";

const reviewJob = { id: "review-job", title: "Review this codebase", description: "Review code quality: https://github.com/acme/demo", acceptanceCriteria: ["Give a score and explain findings"], category: "coding" };

describe("Josh code review handler", () => {
  test("accepts only coding jobs requesting review and containing source", async () => {
    expect(isCodeReviewJob(reviewJob)).toBe(true);
    expect((await assessCodeReviewFit(reviewJob)).suitable).toBe(true);
    expect(isCodeReviewJob({ ...reviewJob, title: "Build a new website", description: "https://github.com/acme/demo" })).toBe(false);
    expect(isCodeReviewJob({ ...reviewJob, description: "Review code quality", title: "Code review" })).toBe(false);
    expect(isCodeReviewJob({ ...reviewJob, category: "writing" })).toBe(false);
  });

  test("accepts only HTTPS GitHub repository hosts", () => {
    expect(parseGitHubRepoUrl("https://github.com/acme/sample/tree/main/src")).toEqual({ owner: "acme", repo: "sample" });
    expect(parseGitHubRepoUrl("http://github.com/acme/sample")).toBeNull();
    expect(parseGitHubRepoUrl("https://github.com.evil.test/acme/sample")).toBeNull();
    expect(parseGitHubRepoUrl("https://gitlab.com/acme/sample")).toBeNull();
  });

  test("extracts attached source files without treating fenced text as executable", () => {
    expect(extractInlineSources("[SOURCE FILE: src/a.ts]\n```\nconst answer = 42;\n```\n\n[SOURCE FILE: .env]\n```\nSECRET\n```"))
      .toEqual([{ path: "src/a.ts", content: "const answer = 42;\n" }]);
  });

  test("formats a scored assessment as a normal marketplace submission", () => {
    const submission = formatReview({ score: 84, summary: "Readable and well organized.", strengths: ["Clear modules"], findings: [{ priority: "medium", title: "Missing tests", file: "src/app.ts", detail: "Core branch has no tests.", recommendation: "Add a focused unit test." }], caveats: ["Only supplied files were reviewed."] }, [{ path: "src/app.ts", content: "" }], ["https://github.com/acme/demo"]);
    expect(submission.summary).toContain("84/100");
    expect(submission.deliverable).toContain("not a security audit");
    expect(submission.deliverable).toContain("Missing tests");
    expect(submission.evidence).toEqual(["https://github.com/acme/demo"]);
    expect(() => formatReview({ score: 140, summary: "bad", strengths: [], findings: [], caveats: [] }, [], [])).toThrow("complete scored code review");
  });
});
