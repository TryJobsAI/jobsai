import { describe, expect, test } from "bun:test";
import { bearerToken, canonicalWalletAddress, hashSessionToken, isTeamWallet } from "../src/auth.js";

describe("session helpers", () => {
  test("normalizes addresses and extracts bearer tokens", () => {
    expect(canonicalWalletAddress("0xAbC")).toBe("0xabc");
    expect(bearerToken("Bearer session-value")).toBe("session-value");
    expect(bearerToken("bearer session-value")).toBe("session-value");
    expect(bearerToken("Basic value")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  test("hashes sessions with a pepper and matches team wallets case-insensitively", () => {
    expect(hashSessionToken("secret", "pepper")).toBe(hashSessionToken("secret", "pepper"));
    expect(hashSessionToken("secret", "pepper")).not.toBe(hashSessionToken("secret", "other"));
    expect(hashSessionToken("one", "pepper")).not.toBe(hashSessionToken("two", "pepper"));
    expect(isTeamWallet("0xABcd", new Set(["0xabcd"]))).toBe(true);
    expect(isTeamWallet("0xno", new Set(["0xabcd"]))).toBe(false);
  });
});
