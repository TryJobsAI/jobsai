import { describe, expect, test } from "bun:test";
import { draftJobSpec, jobDraftRequestSchema, normalizeJobDraft } from "../src/job-draft.js";

const completion = (content: unknown, status = 200) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status });

describe("one-sentence job drafting", () => {
  test("turns a model reply into a reviewable job brief", async () => {
    let sentBody: any;
    const draft = await draftJobSpec("Rewrite my bakery's About page so it sounds warm and local", {
      apiKey: "test-key",
      model: "test-model",
      fetcher: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return completion({
          title: "Rewrite a bakery About page",
          description: "Rewrite the About page for a neighborhood bakery.\n\nThe client will share the current page text.",
          acceptanceCriteria: ["Under 300 words", "Mentions the neighborhood by name", "Delivered as plain text"],
          category: "writing",
        })();
      },
    });
    expect(draft).toEqual({
      title: "Rewrite a bakery About page",
      description: "Rewrite the About page for a neighborhood bakery.\n\nThe client will share the current page text.",
      acceptanceCriteria: ["Under 300 words", "Mentions the neighborhood by name", "Delivered as plain text"],
      category: "writing",
    });
    expect(sentBody.model).toBe("test-model");
    expect(sentBody.response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(sentBody.messages[1].content)).toEqual({ request: "Rewrite my bakery's About page so it sounds warm and local" });
  });

  test("clamps oversized fields and falls back to the other category", () => {
    const draft = normalizeJobDraft({
      title: "x".repeat(400),
      description: "Build a pricing table.",
      acceptanceCriteria: Array.from({ length: 30 }, (_, index) => ` Criterion ${index} `).concat([""]),
      category: "crypto_trading",
    });
    expect(draft.title).toHaveLength(160);
    expect(draft.acceptanceCriteria).toHaveLength(20);
    expect(draft.acceptanceCriteria[0]).toBe("Criterion 0");
    expect(draft.category).toBe("other");
  });

  test("rejects incomplete, unreadable, and failed model replies", async () => {
    const options = { apiKey: "test-key", model: "test-model" };
    await expect(draftJobSpec("Translate a restaurant menu into Spanish", { ...options, fetcher: completion({ title: "Menu", acceptanceCriteria: [] }) }))
      .rejects.toMatchObject({ status: 502, code: "job_draft_incomplete" });
    await expect(draftJobSpec("Translate a restaurant menu into Spanish", { ...options, fetcher: completion("not json") }))
      .rejects.toMatchObject({ status: 502, code: "job_draft_incomplete" });
    await expect(draftJobSpec("Translate a restaurant menu into Spanish", { ...options, fetcher: completion({}, 500) }))
      .rejects.toMatchObject({ status: 502, code: "job_draft_unavailable" });
    await expect(draftJobSpec("Translate a restaurant menu into Spanish", { ...options, fetcher: async () => { throw new Error("offline"); } }))
      .rejects.toMatchObject({ status: 502, code: "job_draft_unavailable" });
  });

  test("requires a configured key and a usable sentence", async () => {
    await expect(draftJobSpec("Translate a restaurant menu into Spanish", { apiKey: undefined, model: "test-model" }))
      .rejects.toMatchObject({ status: 503, code: "job_draft_unconfigured" });
    expect(jobDraftRequestSchema.safeParse({ prompt: "  short " }).success).toBe(false);
    expect(jobDraftRequestSchema.safeParse({ prompt: "x".repeat(601) }).success).toBe(false);
    expect(jobDraftRequestSchema.parse({ prompt: "  Clean up my sales spreadsheet  " }).prompt).toBe("Clean up my sales spreadsheet");
  });
});
