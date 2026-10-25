import { describe, expect, test } from "bun:test";
import { bearerToken, canonicalWalletAddress, createTeamSessionToken, hashSessionToken, isTeamWallet, isValidTeamSessionToken, teamPasswordsMatch } from "../src/auth.js";

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

  test("compares team passwords safely and accepts only unexpired signed team sessions", () => {
    const secret = "an-example-team-password-longer-than-32-characters";
    const now = Date.UTC(2030, 0, 1);
    const token = createTeamSessionToken(secret, now);
    expect(teamPasswordsMatch(secret, secret)).toBe(true);
    expect(teamPasswordsMatch("wrong-password", secret)).toBe(false);
    expect(isValidTeamSessionToken(token, secret, now)).toBe(true);
    expect(isValidTeamSessionToken(token, "a-different-secret-that-is-at-least-32-chars", now)).toBe(false);
    expect(isValidTeamSessionToken(token, secret, now + 8 * 60 * 60 * 1000)).toBe(false);
    expect(isValidTeamSessionToken(undefined, secret, now)).toBe(false);
  });
});
