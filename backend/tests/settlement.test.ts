import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { buildPayoutTransaction, escrowGasReserve, escrowSweepAmount } from "../src/settlement.js";

const recipient = `0x${"11".repeat(20)}` as Address;
const token = `0x${"22".repeat(20)}` as Address;

describe("settlement transaction construction", () => {
  test("pays exact ETH amount directly to the doer", () => {
    expect(buildPayoutTransaction({ asset: "eth", recipient, amount_raw: "12345", token_address: null })).toEqual({
      to: recipient, value: 12345n, data: "0x", gas: 21_000n,
    });
  });

  test("encodes exact USDG transfer to the selected recipient", () => {
    const tx = buildPayoutTransaction({ asset: "usdg", recipient, amount_raw: "12345", token_address: token });
    expect(tx.to).toBe(token);
    expect(tx.value).toBe(0n);
    expect(tx.gas).toBe(100_000n);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data })).toEqual({ functionName: "transfer", args: [recipient, 12345n] });
  });

  test("reserves gas for both payout assets and sweeps only the remaining ETH", () => {
    expect(escrowGasReserve(10n, "eth")).toBe(1_440_000n);
    expect(escrowGasReserve(10n, "usdg")).toBe(3_020_000n);
    expect(escrowSweepAmount(500_000n, 10n)).toBe(290_000n);
    expect(escrowSweepAmount(100n, 10n)).toBe(0n);
  });
});
