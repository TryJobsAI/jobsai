import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { buildPayoutTransaction, escrowGasReserve, escrowSweepAmount, gasLimitWithBuffer, gasWalletRequiredBalance, replacementGasPrice, settlementRetryDelaySeconds } from "../src/settlement.js";

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

  test("calculates exact sponsorship requirements from live estimates without a fixed wallet floor", () => {
    expect(gasLimitWithBuffer(21_000n)).toBe(25_200n);
    expect(gasLimitWithBuffer(21_001n)).toBe(25_202n);
    expect(gasLimitWithBuffer(120n, 0n)).toBe(120n);
    expect(() => gasLimitWithBuffer(0n)).toThrow();
    expect(escrowGasReserve(10n, 25_200n, 30_000n, 25_200n)).toBe(1_608_000n);
    expect(gasWalletRequiredBalance(1_608_000n, 10n, 25_200n)).toBe(1_860_000n);
    expect(gasWalletRequiredBalance(0n, 10n, 21_000n)).toBe(210_000n);
    expect(settlementRetryDelaySeconds(1)).toBe(30);
    expect(settlementRetryDelaySeconds(2)).toBe(60);
    expect(settlementRetryDelaySeconds(3)).toBe(120);
    expect(settlementRetryDelaySeconds(4)).toBe(240);
    expect(settlementRetryDelaySeconds(20)).toBe(300);
    expect(() => settlementRetryDelaySeconds(0)).toThrow();
    expect(replacementGasPrice(100n, 110n)).toBe(120n);
    expect(replacementGasPrice(100n, 150n)).toBe(150n);
    expect(() => replacementGasPrice(0n, 100n)).toThrow();
    expect(escrowSweepAmount(500_000n, 10n, 25_200n)).toBe(248_000n);
    expect(escrowSweepAmount(100n, 10n, 25_200n)).toBe(0n);
  });
});
