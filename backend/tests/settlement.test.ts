import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { buildPayoutTransaction, escrowGasReserve, escrowSweepAmount, gasLimitWithBuffer } from "../src/settlement.js";

const recipient = `0x${"11".repeat(20)}` as Address;
const token = `0x${"22".repeat(20)}` as Address;

describe("settlement transaction construction", () => {
  test("pays exact ETH amount directly to the doer", () => {
    expect(buildPayoutTransaction({ asset: "eth", recipient, amount_raw: "12345", token_address: null })).toEqual({
      to: recipient, value: 12345n, data: "0x",
    });
  });

  test("encodes exact USDG transfer to the selected recipient", () => {
    const tx = buildPayoutTransaction({ asset: "usdg", recipient, amount_raw: "12345", token_address: token });
    expect(tx.to).toBe(token);
    expect(tx.value).toBe(0n);
    expect(tx).not.toHaveProperty("gas");
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data })).toEqual({ functionName: "transfer", args: [recipient, 12345n] });
  });

  test("buffers live estimates and reserves enough for each estimated settlement stage", () => {
    expect(gasLimitWithBuffer(21_000n)).toBe(25_200n);
    expect(gasLimitWithBuffer(21_001n)).toBe(25_202n);
    expect(gasLimitWithBuffer(120n, 0n)).toBe(120n);
    expect(() => gasLimitWithBuffer(0n)).toThrow();
    expect(escrowGasReserve(10n, 25_200n, 30_000n, 25_200n)).toBe(1_608_000n);
    expect(escrowSweepAmount(500_000n, 10n, 25_200n)).toBe(248_000n);
    expect(escrowSweepAmount(100n, 10n, 25_200n)).toBe(0n);
  });
});
