import { expect, test } from "bun:test";
import type { Request } from "express";
import { requestIdentity } from "../src/rate-limit.js";

test("unauthenticated wallet limits are scoped to both client IP and wallet", () => {
  const wallet = `0x${"aB".repeat(20)}`;
  const request = (ip: string, address: string) => ({ ip, body: { address } }) as unknown as Request;
  const fromFirstIp = requestIdentity.walletFromBodyAndIp(request("203.0.113.5", wallet));
  const fromSecondIp = requestIdentity.walletFromBodyAndIp(request("203.0.113.6", wallet));
  expect(fromFirstIp).toBe("203.0.113.5:0xabababababababababababababababababababab");
  expect(fromSecondIp).not.toBe(fromFirstIp);
  expect(requestIdentity.walletFromBodyAndIp(request("203.0.113.5", "invalid"))).toBeUndefined();
});
