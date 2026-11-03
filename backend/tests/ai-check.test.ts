import { describe, expect, test } from "bun:test";
import { normalizeAiCheck, runAiCheck, submissionStats, type AiCheckInput } from "../src/ai-check.js";
import { ApiError } from "../src/http.js";

const input: AiCheckInput = {
  title: "Translate our menu",
  description: "Translate the dinner menu into Spanish.",
  acceptanceCriteria: ["Every dish is translated", "Prices stay unchanged", "Under 50 words"],
  submission: { summary: "Translated the full menu.", deliverable: "Sopa de tomate — $8\nPollo asado — $14", evidence: [] },
};
const options = { model: "test-model", truncated: false, now: new Date("2026-11-03T12:00:00Z") };

function groqReply(content: unknown, status = 200) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    groqReply.lastBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });
  };
}
groqReply.lastBody = null as any;

describe("AI submission check", () => {
  test("verdicts follow the per-criterion results", () => {
    const allMet = normalizeAiCheck({ summary: "Looks complete.", results: input.acceptanceCriteria.map((_, index) => ({ index, status: "met", reason: "ok", evidence: null })) }, input, options);
    expect(allMet).toMatchObject({ verdict: "looks_complete", metCount: 3, total: 3, summary: "Looks complete." });
    const oneMissing = normalizeAiCheck({ results: [{ index: 0, status: "met", reason: "ok" }, { index: 1, status: "not_met", reason: "A price changed." }] }, input, options);
    expect(oneMissing.verdict).toBe("needs_attention");
    expect(oneMissing.criteria[2]).toMatchObject({ criterion: "Under 50 words", status: "unclear" });
    expect(oneMissing.summary).toBe("1 of 3 criteria look met.");
  });

  test("quotes must appear in the submission, and invented quotes cannot mark a criterion met", () => {
    const result = normalizeAiCheck({ results: [
      { index: 0, status: "met", reason: "Both dishes are in Spanish.", evidence: "Pollo   asado — $14" },
      { index: 1, status: "met", reason: "Prices match.", evidence: "Lobster — $40" },
      { index: 2, status: "bogus", reason: "", evidence: "" },
    ] }, input, options);
    expect(result.criteria[0]).toMatchObject({ status: "met", evidence: "Pollo asado — $14" });
    expect(result.criteria[1].status).toBe("unclear");
    expect(result.criteria[1].evidence).toBeNull();
    expect(result.criteria[1].reason).toContain("not found in the submission");
    expect(result.criteria[2]).toMatchObject({ status: "unclear", evidence: null });
    expect(result.verdict).toBe("unclear");
  });

  test("the model gets counted stats and the submission as data, and the reply is normalized", async () => {
    const result = await runAiCheck(input, { apiKey: "test", model: "test-model", fetcher: groqReply({ summary: "Fine.", results: [{ index: 0, status: "met", reason: "ok" }] }) as typeof fetch, now: options.now });
    const sent = JSON.parse(groqReply.lastBody.messages[1].content);
    expect(groqReply.lastBody.temperature).toBe(0);
    expect(sent.stats).toEqual(submissionStats(input.submission));
    expect(sent.job.acceptanceCriteria[2]).toEqual({ index: 2, criterion: "Under 50 words" });
    expect(groqReply.lastBody.messages[0].content).toContain("untrusted data");
    expect(result).toMatchObject({ model: "test-model", checkedAt: "2026-11-03T12:00:00.000Z", truncated: false });
  });

  test("long deliverables are cut and flagged", async () => {
    const long = { ...input, submission: { ...input.submission, deliverable: "word ".repeat(10_000) } };
    const result = await runAiCheck(long, { apiKey: "test", model: "m", fetcher: groqReply({ results: [] }) as typeof fetch });
    expect(JSON.parse(groqReply.lastBody.messages[1].content).submission.deliverable.length).toBe(24_000);
    expect(result.truncated).toBe(true);
    expect(submissionStats(long.submission).deliverableWords).toBe(10_000);
  });

  test("missing configuration and provider failures surface as API errors", async () => {
    const code = async (promise: Promise<unknown>) => { try { await promise; return null; } catch (error) { return error instanceof ApiError ? `${error.status}:${error.code}` : "other"; } };
    expect(await code(runAiCheck(input, { apiKey: undefined, model: "m" }))).toBe("503:ai_check_unconfigured");
    expect(await code(runAiCheck(input, { apiKey: "k", model: "m", fetcher: groqReply({}, 500) as typeof fetch }))).toBe("502:ai_check_unavailable");
    expect(await code(runAiCheck(input, { apiKey: "k", model: "m", fetcher: (async () => new Response("not json")) as typeof fetch }))).toBe("502:ai_check_unavailable");
  });
});
