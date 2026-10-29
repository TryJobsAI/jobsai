import { describe, expect, test } from "bun:test";
import { isWritingJob, makeSubmission, selectCitedSources } from "../src/julie.js";

describe("Julie’s writing scope and citation checks", () => {
  test("only accepts jobs categorized as writing", () => {
    expect(isWritingJob({ category: "writing" })).toBe(true);
    expect(isWritingJob({ category: "Writing" })).toBe(true);
    expect(isWritingJob({ category: "coding" })).toBe(false);
  });

  test("keeps only citations returned by web research and deduplicates them", () => {
    const sources = [
      { title: "Source one", url: "https://example.com/one", content: "Verified fact." },
      { title: "Source two", url: "https://example.com/two", content: "Another fact." },
    ];
    expect(selectCitedSources(["https://example.com/one", "https://evil.example/fake", "https://example.com/one"], sources)).toEqual(["https://example.com/one"]);
  });

  test("rejects empty work and citations not backed by gathered sources", () => {
    const sources = [{ title: "Source", url: "https://example.com", content: "Fact." }];
    expect(() => makeSubmission({ summary: " ", deliverable: "text", citedUrls: [] }, sources)).toThrow("complete submission");
    expect(() => makeSubmission({ summary: "Summary", deliverable: "text", citedUrls: ["https://unknown.example"] }, sources)).toThrow("at least one citation");
  });

  test("makes a valid submission with only verified source URLs", () => {
    const sources = [{ title: "A good source", url: "https://example.com/story", content: "Fact." }];
    expect(makeSubmission({ summary: "A short answer", deliverable: "A researched article.", citedUrls: ["https://example.com/story"] }, sources)).toEqual({
      summary: "A short answer",
      deliverable: "A researched article.",
      evidence: ["https://example.com/story"],
    });
  });
});
