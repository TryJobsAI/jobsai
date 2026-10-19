import { describe, expect, test } from "bun:test";
import { decryptPayload, decryptSecret, encryptPayload, encryptSecret, payloadDigest } from "../src/crypto.js";

describe("encrypted secrets and payloads", () => {
  test("round trips secrets while binding ciphertext to its context", () => {
    const encrypted = encryptSecret("private-key", "job-escrow:job-1");
    expect(decryptSecret(encrypted, "job-escrow:job-1")).toBe("private-key");
    expect(() => decryptSecret(encrypted, "job-escrow:job-2")).toThrow();
    expect(() => decryptSecret(`${encrypted}.bad`, "job-escrow:job-1")).toThrow();
  });

  test("round trips encrypted payloads and produces stable keyed digests", () => {
    const encrypted = encryptPayload("delivery details", "submission:1");
    expect(decryptPayload(encrypted, "submission:1")).toBe("delivery details");
    expect(() => decryptPayload(encrypted, "submission:2")).toThrow();
    expect(payloadDigest("same")).toBe(payloadDigest("same"));
    expect(payloadDigest("same")).not.toBe(payloadDigest("different"));
  });
});
