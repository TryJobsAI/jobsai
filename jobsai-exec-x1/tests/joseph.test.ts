import { describe, expect, test } from "bun:test";
import { analyzeDataJob, assessDataJob, parseAndCleanCsv } from "../src/joseph.js";
import type { WritingJob } from "../src/jobsai.js";
import { config } from "../src/config.js";

const job: WritingJob = {
  id: "e2d43bc9-f53f-4492-8f50-ab74dd03c149", title: "Clean the customer dataset", category: "data",
  description: "Remove duplicate rows and report blank fields.", acceptanceCriteria: ["Return cleaned CSV", "Explain findings"],
  sourceFileUrl: "https://res.cloudinary.com/jobsai/raw/upload/jobsai/job-sources/e2d43bc9-f53f-4492-8f50-ab74dd03c149/source.csv",
};

describe("Joseph data worker", () => {
  test("trims cells, removes exact duplicate rows, and reports blanks and mixed values", () => {
    const result = parseAndCleanCsv("name,amount\r\n Alice ,10\r\nAlice,10\r\nBob,unknown\r\nCara, \r\n");
    expect(result.rowsBefore).toBe(4);
    expect(result.rowsAfter).toBe(3);
    expect(result.csv).toContain("Alice,10");
    expect(result.csv).not.toContain("Alice ,10");
    expect(result.findings.join(" ")).toContain("Removed 1 exact duplicate row");
    expect(result.findings.join(" ")).toContain("blank value");
    expect(result.findings.join(" ")).toContain("mixes numeric-looking");
    expect(result.findings.join(" ")).toContain("numeric summary: count 1, sum 10, average 10, minimum 10, maximum 10");
  });

  test("handles quoted commas and protects spreadsheet formula cells", () => {
    const result = parseAndCleanCsv('name,note\nAda,"hello, world"\nEve,"=HYPERLINK(""https://bad"")"\n');
    expect(result.csv).toContain('"hello, world"');
    expect(result.csv).toContain("'=HYPERLINK");
  });

  test("rejects malformed rows and ambiguous headers", () => {
    expect(() => parseAndCleanCsv("a,b\n1\n")).toThrow("inconsistent column counts");
    expect(() => parseAndCleanCsv("a,A\n1,2\n")).toThrow("distinct, non-empty header");
  });

  test("accepts only data-category work with an attached CSV", async () => {
    expect(await assessDataJob(job)).toMatchObject({ suitable: true });
    expect(await assessDataJob({ ...job, category: "writing" })).toMatchObject({ suitable: false });
    expect(await assessDataJob({ ...job, sourceFileUrl: null })).toMatchObject({ suitable: false });
  });

  test("downloads the attached CSV, uploads cleaned output, and submits sourced findings", async () => {
    Object.assign(config, { openRouterApiKey: "test-key", openRouterDataModel: "test-model" });
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === job.sourceFileUrl) return new Response("name,amount\nAda,3\nAda,3\n", { status: 200 });
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        calls.push("analysis");
        return Response.json({ choices: [{ message: { content: "The file has two records; one exact duplicate was removed." } }] });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const submission = await analyzeDataJob(job, "token", async (_id, _token, bytes, mime, name) => {
      calls.push(`upload:${mime}:${name}`);
      expect(new TextDecoder().decode(bytes)).toContain("Ada,3");
      return { url: "https://res.cloudinary.com/jobsai/raw/upload/jobsai/submissions/job/cleaned.csv" };
    }, fetcher);
    expect(calls).toEqual(["analysis", "upload:text/csv:joseph-cleaned-e2d43bc9-f53f-4492-8f50-ab74dd03c149.csv"]);
    expect(submission.summary).toContain("2 rows into 1 rows");
    expect(submission.deliverable).toContain("The file has two records");
    expect(submission.evidence[0]).toContain("cleaned.csv");
  });

  test("rejects source links outside the assigned JobsAI job folder", async () => {
    await expect(analyzeDataJob({ ...job, sourceFileUrl: "https://example.com/data.csv" }, "token", async () => ({ url: "" }), fetch))
      .rejects.toThrow("not a supported JobsAI CSV attachment");
  });
});
