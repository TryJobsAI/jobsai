import { describe, expect, test } from "bun:test";
import { config } from "../src/config.js";
import { processAgentToken } from "../src/worker.js";

// Worker tests inject every external operation, so they need no real provider credentials.
Object.assign(config, { groqApiKey: "test", groqModel: "test", tavilyApiKey: "test", openRouterApiKey: "test", openRouterCodeModel: "test" });

const profile = { id: "agent-id", name: "Writing worker", categories: ["writing"], capabilities: [], ownerWallet: "0x1111111111111111111111111111111111111111" };
const job = { id: "job-id", title: "Write a sourced article", description: "Use public sources.", acceptanceCriteria: ["Cite sources"], category: "writing" };

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    profile: async () => profile,
    assignedJobs: async () => [],
    availableJobs: async () => [job],
    claim: async () => undefined,
    submit: async () => undefined,
    unclaim: async () => undefined,
    assess: async () => ({ suitable: true, reason: "supported", queries: ["public subject research"] }),
    write: async () => ({ summary: "Summary", deliverable: "Article", evidence: [] }),
    ...overrides,
  } as any;
}

describe("Exec X1 worker", () => {
  test("assesses before claiming and submits one eligible job", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      assess: async () => { calls.push("assess"); return { suitable: true, queries: ["one"] }; },
      claim: async () => calls.push("claim"),
      write: async (_job: unknown, queries: string[]) => { calls.push(`write:${queries[0]}`); return { summary: "ok", deliverable: "thread", evidence: [] }; },
      submit: async () => calls.push("submit"),
    });
    expect(await processAgentToken("token", deps)).toMatchObject({ processed: 1, jobId: "job-id" });
    expect(calls).toEqual(["assess", "claim", "write:one", "submit"]);
  });

  test("does not claim a job the suitability check declines", async () => {
    let claimed = false;
    const deps = dependencies({ assess: async () => ({ suitable: false, reason: "out of scope", queries: [] }), claim: async () => { claimed = true; } });
    expect(await processAgentToken("token", deps)).toMatchObject({ processed: 0 });
    expect(claimed).toBe(false);
  });

  test("releases a new claim when drafting fails, then reports the failure", async () => {
    let released = false;
    const deps = dependencies({ write: async () => { throw new Error("provider unavailable"); }, unclaim: async () => { released = true; } });
    await expect(processAgentToken("token", deps)).rejects.toThrow("provider unavailable");
    expect(released).toBe(true);
  });

  test("resumes a revision without claiming it again", async () => {
    let claimed = false;
    const assigned = { ...job, status: "revision_requested", revisionFeedback: "Add two examples." };
    const deps = dependencies({
      assignedJobs: async () => [assigned],
      claim: async () => { claimed = true; },
      write: async (candidate: typeof assigned) => ({ summary: candidate.revisionFeedback!, deliverable: "revised article", evidence: [] }),
    });
    expect(await processAgentToken("token", deps)).toMatchObject({ processed: 1 });
    expect(claimed).toBe(false);
  });

  test("ignores an agent profile outside the writing category", async () => {
    let scanned = false;
    const deps = dependencies({ profile: async () => ({ ...profile, categories: ["research"] }), availableJobs: async () => { scanned = true; return [job]; } });
    expect(await processAgentToken("token", deps)).toMatchObject({ processed: 0 });
    expect(scanned).toBe(false);
  });

  test("John claims an image-generation job and submits its hosted image", async () => {
    const imageJob = { ...job, id: "image-job", category: "image_generation" };
    const calls: string[] = [];
    const deps = dependencies({
      profile: async () => ({ ...profile, name: "Image worker", categories: ["research", "image_generation"] }),
      availableJobs: async () => [job, imageJob],
      assess: async (_candidate: unknown, category: string) => { calls.push(`assess:${category}`); return { suitable: true }; },
      claim: async (id: string) => calls.push(`claim:${id}`),
      write: async (_candidate: unknown, _queries: string[], _token: string, category: string) => {
        calls.push(`generate:${category}`);
        return { summary: "Generated image", deliverable: "https://res.cloudinary.com/jobsai/image/upload/image.webp", evidence: ["https://res.cloudinary.com/jobsai/image/upload/image.webp"] };
      },
      submit: async (_id: string, _token: string, body: any) => calls.push(`submit:${body.evidence[0]}`),
    });
    expect(await processAgentToken("john-token", deps)).toMatchObject({ processed: 1, jobId: "image-job" });
    expect(calls).toEqual(["assess:image_generation", "claim:image-job", "generate:image_generation", "submit:https://res.cloudinary.com/jobsai/image/upload/image.webp"]);
  });

  test("Jayla claims a translation job and submits the requested document artifact", async () => {
    const translationJob = { ...job, id: "translation-job", title: "Translate an article", category: "translation", description: "Translate this article into French." };
    const calls: string[] = [];
    const deps = dependencies({
      profile: async () => ({ ...profile, name: "Jayla", categories: ["translation"] }),
      availableJobs: async () => [translationJob],
      assess: async (_candidate: unknown, category: string) => { calls.push(`assess:${category}`); return { suitable: true }; },
      claim: async (id: string) => calls.push(`claim:${id}`),
      write: async (_candidate: unknown, _queries: string[], _token: string, category: string) => {
        calls.push(`translate:${category}`);
        return { summary: "Translated into French", deliverable: "PDF translation link", evidence: ["https://res.cloudinary.com/jobsai/raw/upload/translation.pdf"] };
      },
      submit: async (_id: string, _token: string, body: any) => calls.push(`submit:${body.evidence[0]}`),
    });
    expect(await processAgentToken("jayla-token", deps)).toMatchObject({ processed: 1, jobId: "translation-job" });
    expect(calls).toEqual(["assess:translation", "claim:translation-job", "translate:translation", "submit:https://res.cloudinary.com/jobsai/raw/upload/translation.pdf"]);
  });

  test("Joseph claims a data job and submits the cleaned CSV deliverable", async () => {
    const dataJob = { ...job, id: "data-job", category: "data", sourceFileUrl: "https://res.cloudinary.com/jobsai/raw/upload/source.csv" };
    const calls: string[] = [];
    const deps = dependencies({
      profile: async () => ({ ...profile, name: "Joseph", categories: ["data"] }),
      availableJobs: async () => [dataJob],
      assess: async (_candidate: unknown, category: string) => { calls.push(`assess:${category}`); return { suitable: true }; },
      claim: async (id: string) => calls.push(`claim:${id}`),
      write: async (_candidate: unknown, _queries: string[], _token: string, category: string) => {
        calls.push(`analyze:${category}`);
        return { summary: "Cleaned CSV", deliverable: "Download cleaned CSV", evidence: ["https://res.cloudinary.com/jobsai/raw/upload/cleaned.csv"] };
      },
      submit: async (_id: string, _token: string, body: any) => calls.push(`submit:${body.evidence[0]}`),
    });
    expect(await processAgentToken("joseph-token", deps)).toMatchObject({ processed: 1, jobId: "data-job" });
    expect(calls).toEqual(["assess:data", "claim:data-job", "analyze:data", "submit:https://res.cloudinary.com/jobsai/raw/upload/cleaned.csv"]);
  });
});
