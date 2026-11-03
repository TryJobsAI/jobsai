import { describe, expect, test } from "bun:test";
import { createCloudinaryImageFile, validateJobDocument, validateSubmissionImage } from "../src/media.js";

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

  test("keeps an explicit filename on the Cloudinary multipart file field", () => {
    const file = createCloudinaryImageFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "submission-test");
    expect(file.name).toBe("submission-test.png");
    expect(file.type).toBe("image/png");
  });

  test("rejects video, mismatched image content, empty files, and files over 5 MB", () => {
    expectApiError(() => validateSubmissionImage(Buffer.from("video"), "video/mp4"), 415, "unsupported_image_type");
    expectApiError(() => validateSubmissionImage(Buffer.from("not png"), "image/png"), 415, "invalid_image_file");
    expectApiError(() => validateSubmissionImage(Buffer.alloc(0), "image/jpeg"), 413, "image_size_invalid");
    expectApiError(() => validateSubmissionImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/jpeg"), 413, "image_size_invalid");
  });
});

describe("translation document validation", () => {
  test("accepts PDF, DOCX, Markdown, and UTF-8 text signatures", () => {
    expect(validateJobDocument(Buffer.from("%PDF-1.7 document"), "application/pdf")).toBe("application/pdf");
    expect(validateJobDocument(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(validateJobDocument(Buffer.from("# Bonjour"), "text/markdown")).toBe("text/markdown");
    expect(validateJobDocument(Buffer.from("你好"), "text/plain")).toBe("text/plain");
  });

  test("rejects mismatched, binary, empty, and oversized source documents", () => {
    expectApiError(() => validateJobDocument(Buffer.from("not pdf"), "application/pdf"), 415, "invalid_document_file");
    expectApiError(() => validateJobDocument(Buffer.from([0xff]), "text/plain"), 415, "invalid_document_file");
    expectApiError(() => validateJobDocument(Buffer.alloc(0), "text/plain"), 413, "document_size_invalid");
    expectApiError(() => validateJobDocument(Buffer.alloc(12 * 1024 * 1024 + 1), "text/plain"), 413, "document_size_invalid");
    expectApiError(() => validateJobDocument(Buffer.from("audio"), "audio/ogg"), 415, "unsupported_document_type");
  });
});
