import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hash } from "viem";
import { loadEscrowAccount, makeEscrowWallet, parseHash, validateJobFunding, type FundingProof, type FundingTerms } from "../src/escrow.js";
import { config } from "../src/config.js";

const hash = `0x${"ab".repeat(32)}` as Hash;
const client = `0x${"11".repeat(20)}` as Address;
const escrow = `0x${"22".repeat(20)}` as Address;
const token = `0x${"33".repeat(20)}` as Address;
const base = { transaction: { chainId: config.RH_CHAIN_ID, from: client, to: escrow, value: 500n, input: "0x" },
  receipt: { status: "success", blockNumber: 100n, logs: [] }, latestBlock: 200n };
const terms: FundingTerms = { id: "job", client_wallet: client, asset: "eth", amount_raw: "500", token_address: null };

function code(run: () => unknown) {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  throw new Error("Expected funding validation to fail.");
}
function usdgProof(): FundingProof {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: client, to: escrow } });
  const log = { address: token, topics, data: encodeAbiParameters([{ type: "uint256" }], [2_500_000n]),
    blockHash: `0x${"44".repeat(32)}`, blockNumber: 100n, transactionHash: hash, transactionIndex: 0,
    logIndex: 0, removed: false };
  return { transaction: { chainId: config.RH_CHAIN_ID, from: client, to: token, value: 0n, input: "0x" },
    receipt: { status: "success", blockNumber: 100n, logs: [log] }, latestBlock: 200n };
}

describe("job escrow and funding proof", () => {
  test("validates transaction hashes and binds encrypted escrow keys to job ids", () => {
    expect(parseHash(hash)).toBe(hash);
    expect(() => parseHash("0x1234")).toThrow("valid transaction hash");
    const wallet = makeEscrowWallet("job-1");
    expect(wallet.encryptedPrivateKey).not.toContain(wallet.address);
    expect(loadEscrowAccount("job-1", wallet.encryptedPrivateKey).address.toLowerCase()).toBe(wallet.address);
    expect(() => loadEscrowAccount("job-2", wallet.encryptedPrivateKey)).toThrow();
  });

  test("accepts exact confirmed ETH only, from the client to the escrow", () => {
    expect(validateJobFunding(terms, escrow, hash, base)).toEqual({ hash, blockNumber: "100" });
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, transaction: { ...base.transaction, value: 499n } }))).toBe("funding_amount_mismatch");
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, transaction: { ...base.transaction, input: "0x01" } }))).toBe("funding_amount_mismatch");
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, transaction: { ...base.transaction, chainId: 1 } }))).toBe("wrong_chain");
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, transaction: { ...base.transaction, from: escrow } }))).toBe("funding_wallet_mismatch");
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, latestBlock: 100n + BigInt(config.RH_CONFIRMATIONS - 2) }))).toBe("funding_confirmations_pending");
    expect(code(() => validateJobFunding(terms, escrow, hash, { ...base, receipt: { ...base.receipt, status: "reverted" } }))).toBe("funding_failed");
  });

  test("accepts exact USDG Transfer log and rejects mismatches", () => {
    const usdgTerms: FundingTerms = { ...terms, asset: "usdg", amount_raw: "2500000", token_address: token };
    expect(validateJobFunding(usdgTerms, escrow, hash, usdgProof())).toEqual({ hash, blockNumber: "100" });
    expect(code(() => validateJobFunding(usdgTerms, escrow, hash, { ...usdgProof(), transaction: { ...usdgProof().transaction, to: escrow } }))).toBe("funding_asset_mismatch");
    expect(code(() => validateJobFunding({ ...usdgTerms, amount_raw: "1" }, escrow, hash, usdgProof()))).toBe("funding_amount_mismatch");
  });
});
