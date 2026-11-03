import { describe, expect, test } from "bun:test";
import { assessTranslationJob, createTranslationDocument, getTranslationSource, isTranslationJob, selectTranslationFormat, splitTranslationText, translateJob, translateText } from "../src/jayla.js";

const translationJob = {
  id: "job-12345678",
  title: "Translate a product guide into French",
  description: "Translate the source document into French. Preserve product names.",
  acceptanceCriteria: ["Keep every section", "Deliver the full translation"],
  category: "translation",
};
const plan = { sourceLanguage: "English", targetLanguage: "French", style: "Professional and clear.", preserveTerms: ["JobsAI"] };

function response(content: unknown) {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}

describe("Jayla translation worker", () => {
  test("only accepts translation jobs and requires source material", () => {
    expect(isTranslationJob({ category: "translation" })).toBe(true);
    expect(isTranslationJob({ category: "writing" })).toBe(false);
    expect(assessTranslationJob(translationJob).suitable).toBe(true);
    expect(assessTranslationJob({ ...translationJob, category: "writing" }).suitable).toBe(false);
    expect(assessTranslationJob({ ...translationJob, description: "short" }).suitable).toBe(false);
  });

  test("defaults to PDF and changes format only when revision feedback names one", () => {
    expect(selectTranslationFormat()).toBe("pdf");
    expect(selectTranslationFormat("Please redo it as a Word document.")).toBe("docx");
    expect(selectTranslationFormat("Please return Markdown instead.")).toBe("md");
    expect(selectTranslationFormat("Please revise the terminology.")).toBe("pdf");
  });

  test("splits long source into bounded chunks without losing text", () => {
    const source = `${"First paragraph. ".repeat(30)}\n\n${"第二段。".repeat(30)}`;
    const chunks = splitTranslationText(source, 180);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  test("reads an attached plain text source from JobsAI cloud storage", async () => {
    const result = await getTranslationSource({ ...translationJob, sourceFileUrl: "https://res.cloudinary.com/jobsai/raw/upload/jobsai/job-sources/guide.txt" }, async () => new Response("Bonjour le monde."));
    expect(result.instructions).toBe(translationJob.description);
    expect(result.source).toBe("Bonjour le monde.");
    await expect(getTranslationSource({ ...translationJob, sourceFileUrl: "https://example.com/private.txt" }))
      .rejects.toThrow("attached to this JobsAI translation job");
  });

  test("translates each chunk with the requested language pair and keeps prior context out of repeated output", async () => {
    const seen: string[] = [];
    const text = "Hello world.\n\nGood morning.";
    const translated = await translateText(text, "Use an editorial tone.", plan, {
      apiKey: "test-key", model: "test-model", chunkSize: 100,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const input = JSON.parse(body.messages[1].content);
        seen.push(input.source);
        expect(input.targetLanguage).toBe("French");
        expect(body.temperature).toBe(0);
        return response(`FR:${input.source}`);
      },
    });
    expect(seen.join("")).toBe(text);
    expect(translated).toBe(`FR:${text}`);
  });

  test("makes Unicode PDF or DOCX files and preserves Markdown output", async () => {
    const pdf = await createTranslationDocument("pdf", translationJob.title, "Bonjour, café.");
    expect(pdf.format).toBe("pdf");
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const fallback = await createTranslationDocument("pdf", "Translate", "你好，世界。");
    expect(fallback.format).toBe("docx");
    expect(Buffer.from(fallback.bytes).subarray(0, 2).toString("ascii")).toBe("PK");
    const markdown = await createTranslationDocument("md", "Translate", "# Hola\n\nMundo");
    expect(markdown.format).toBe("md");
    expect(new TextDecoder().decode(markdown.bytes)).toBe("# Hola\n\nMundo");
  });

  test("submits a hosted PDF on first delivery and a hosted DOCX on a requested revision", async () => {
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format) return response(plan);
      const request = JSON.parse(body.messages[1].content);
      return response(`Traduction: ${request.source}`);
    };
    const uploaded: Array<{ mediaType: string; fileName: string }> = [];
    const upload = async (_jobId: string, _token: string, _bytes: Uint8Array, mediaType: string, fileName: string) => {
      uploaded.push({ mediaType, fileName });
      return { url: `https://res.cloudinary.com/jobsai/raw/upload/jobsai/submissions/${fileName}` };
    };
    const first = await translateJob(translationJob, "agent-token", upload, { apiKey: "test", model: "test", fetcher });
    expect(first.evidence[0]).toContain("/raw/upload/");
    expect(first.deliverable).toContain("PDF");
    expect(uploaded[0].mediaType).toBe("application/pdf");

    const revised = await translateJob({ ...translationJob, revisionFeedback: "Redo the translation in DOCX format." }, "agent-token", upload, { apiKey: "test", model: "test", fetcher });
    expect(revised.deliverable).toContain("DOCX");
    expect(uploaded[1].mediaType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
});
