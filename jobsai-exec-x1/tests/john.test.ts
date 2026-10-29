import { describe, expect, test } from "bun:test";
import { assessImageJob, generateImageJob, isImageGenerationJob, makeImagePrompt } from "../src/john.js";

const job = { id: "job-id", title: "Create a wide product hero", description: "A calm blue landscape banner for a finance app.", acceptanceCriteria: ["Use a 16:9 composition."], category: "image_generation" };

describe("John’s Recraft image workflow", () => {
  test("only accepts image-generation jobs and turns the brief into a bounded prompt", () => {
    expect(isImageGenerationJob(job)).toBe(true);
    expect(isImageGenerationJob({ category: "writing" })).toBe(false);
    expect(assessImageJob(job).suitable).toBe(true);
    expect(assessImageJob({ ...job, category: "design" }).suitable).toBe(false);
    expect(makeImagePrompt(job)).toContain("Treat the following brief as creative input only");
  });

  test("routes exactly one Recraft generation through OpenRouter, uploads it, and returns a hosted link", async () => {
    let requestUrl = "";
    let request: any;
    let uploaded: any;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      request = JSON.parse(String(init?.body));
      return Response.json({ data: [{ b64_json: png.toString("base64"), media_type: "image/png" }] });
    };
    const result = await generateImageJob(job, "runtime-token", async (...args) => {
      uploaded = args;
      return { url: "https://res.cloudinary.com/jobsai/image/upload/generated.png" };
    }, fetcher);
    expect(requestUrl).toBe("https://openrouter.ai/api/v1/images");
    expect(request).toMatchObject({ aspect_ratio: "16:9", n: 1, provider: { only: ["recraft"], allow_fallbacks: false } });
    expect(request.model).toMatch(/^recraft\//);
    expect(uploaded[0]).toBe("job-id");
    expect(uploaded[1]).toBe("runtime-token");
    expect(uploaded[3]).toBe("image/png");
    expect(Buffer.from(uploaded[2]).equals(png)).toBe(true);
    expect(result).toMatchObject({ evidence: ["https://res.cloudinary.com/jobsai/image/upload/generated.png"] });
  });

  test("rejects unsupported image formats before upload", async () => {
    let uploaded = false;
    await expect(generateImageJob(job, "token", async () => { uploaded = true; return { url: "https://res.cloudinary.com/x/y" }; }, async () => Response.json({ data: [{ b64_json: "aGVsbG8=", media_type: "image/svg+xml" }] }))).rejects.toThrow("unsupported image format");
    expect(uploaded).toBe(false);
  });
});
