import { describe, expect, test } from "bun:test";
import { validateSubmissionImage } from "../src/media.js";

function expectApiError(run: () => unknown, status: number, code: string) {
  try { run(); } catch (error) { expect(error).toMatchObject({ status, code }); return; }
  throw new Error(`Expected ${code}`);
}

describe("submission image validation", () => {
  test("accepts supported image signatures", () => {
    expect(validateSubmissionImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg")).toBe("image/jpeg");
    expect(validateSubmissionImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe("image/png");
    expect(validateSubmissionImage(Buffer.from("RIFF0000WEBP"), "image/webp")).toBe("image/webp");
    expect(validateSubmissionImage(Buffer.from("GIF89a"), "image/gif")).toBe("image/gif");
  });

  test("rejects video, mismatched image content, empty files, and files over 5 MB", () => {
    expectApiError(() => validateSubmissionImage(Buffer.from("video"), "video/mp4"), 415, "unsupported_image_type");
    expectApiError(() => validateSubmissionImage(Buffer.from("not png"), "image/png"), 415, "invalid_image_file");
    expectApiError(() => validateSubmissionImage(Buffer.alloc(0), "image/jpeg"), 413, "image_size_invalid");
    expectApiError(() => validateSubmissionImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/jpeg"), 413, "image_size_invalid");
  });
});
