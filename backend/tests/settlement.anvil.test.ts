import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  parseTransaction,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const enabled = process.env.JOBSAI_DB_INTEGRATION === "1" && process.env.JOBSAI_ANVIL_INTEGRATION === "1";
const anvilTest = enabled ? test : test.skip;
setDefaultTimeout(120_000);

anvilTest("Anvil settles ETH and USDG, replaces same-nonce gas, accepts an old late receipt, and pauses on low reserve", async () => {
  const [{ db }, { migrate }, { config }, { encryptSecret }, { processSettlement }, { gasWalletAddress, gasAccount }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/migrate.js"),
    import("../src/config.js"),
    import("../src/crypto.js"),
    import("../src/settlement.js"),
    import("../src/escrow.js"),
  ]);
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!databaseUrl.pathname.toLowerCase().includes("test")) throw new Error("Anvil integration tests require a disposable database with 'test' in its name.");
  if (!config.USDG_TOKEN_ADDRESS) throw new Error("Deploy the local MockUSDG contract and set USDG_TOKEN_ADDRESS before running the Anvil suite.");

  const chain = defineChain({
    id: config.RH_CHAIN_ID,
    name: "JobsAI Anvil test chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.RH_RPC_URL] } },
  });
  if (!process.env.ANVIL_TEST_PRIVATE_KEY) throw new Error("Set ANVIL_TEST_PRIVATE_KEY to an Anvil-only test account private key.");
  const signer = privateKeyToAccount(process.env.ANVIL_TEST_PRIVATE_KEY as Hex);
  const publicClient = createPublicClient({ chain, transport: http(config.RH_RPC_URL) });
  const walletClient = createWalletClient({ account: signer, chain, transport: http(config.RH_RPC_URL) });
  const tokenAddress = config.USDG_TOKEN_ADDRESS as Address;
  const tokenAbi = [
    { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  ] as const;
  const jobIds: string[] = [];
  let userIds: string[] = [];
  await migrate();

  async function anvilRpc(method: string, params: unknown[] = []) {
    const response = await fetch(config.RH_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (!response.ok || body.error) throw new Error(`Anvil RPC ${method} failed: ${body.error?.message ?? response.status}`);
    return body.result;
  }

  async function createSettlementCase(asset: "eth" | "usdg", amountRaw: bigint) {
    const jobId = randomUUID();
    const escrowPrivateKey = generatePrivateKey();
    const escrow = privateKeyToAccount(escrowPrivateKey);
    const clientWallet = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const wallets = await db.query<{ id: string }>(
      "INSERT INTO users(wallet_address) VALUES($1),($2) RETURNING id",
      [clientWallet.address.toLowerCase(), recipient.address.toLowerCase()],
    );
    userIds.push(...wallets.rows.map((row) => row.id));
    await db.query(
      `INSERT INTO jobs(id,client_id,doer_id,title,description,acceptance_criteria,asset,amount_raw,token_address,status)
       VALUES($1,$2,$3,$4,'Anvil integration fixture.','["settlement completes"]'::jsonb,$5,$6,$7,'settlement_pending')`,
      [jobId, wallets.rows[0].id, wallets.rows[1].id, `Anvil ${asset} settlement`, asset, amountRaw.toString(), asset === "eth" ? null : tokenAddress.toLowerCase()],
    );
    await db.query("INSERT INTO job_escrow_wallets(job_id,address,encrypted_private_key) VALUES($1,$2,$3)", [
      jobId, escrow.address.toLowerCase(), encryptSecret(escrowPrivateKey, `job-escrow:${jobId}`),
    ]);
    await db.query("INSERT INTO job_settlements(job_id,outcome,recipient,amount_raw) VALUES($1,'pay_doer',$2,$3)", [
      jobId, recipient.address.toLowerCase(), amountRaw.toString(),
    ]);
    jobIds.push(jobId);
    return { jobId, escrow: escrow.address, recipient: recipient.address, amountRaw };
  }

  async function fundEscrow(caseData: Awaited<ReturnType<typeof createSettlementCase>>, asset: "eth" | "usdg") {
    if (asset === "eth") {
      await walletClient.sendTransaction({ to: caseData.escrow, value: caseData.amountRaw });
    } else {
      await walletClient.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "mint", args: [caseData.escrow, caseData.amountRaw] });
    }
  }

  async function setOldGasTransaction(caseData: Awaited<ReturnType<typeof createSettlementCase>>, mine: boolean) {
    if (mine) await anvilRpc("anvil_setAutomine", [true]);
    const nonce = await publicClient.getTransactionCount({ address: gasAccount.address, blockTag: "pending" });
    const raw = await gasAccount.signTransaction({
      to: caseData.escrow,
      value: parseEther("0.01"),
      gas: 21_000n,
      gasPrice: 1_000_000_000n,
      nonce,
      chainId: config.RH_CHAIN_ID,
      type: "legacy",
    });
    const hash = keccak256(raw);
    if (mine) {
      expect(await publicClient.sendRawTransaction({ serializedTransaction: raw })).toBe(hash);
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    } else {
      await anvilRpc("anvil_setAutomine", [false]);
      expect(await publicClient.sendRawTransaction({ serializedTransaction: raw })).toBe(hash);
    }
    const oldBroadcastAt = new Date(Date.now() - 120_000);
    await db.query(
      `UPDATE job_settlements SET gas_nonce=$2,gas_signed_tx=$3,gas_tx_hash=$4,gas_broadcast_at=$5 WHERE job_id=$1`,
      [caseData.jobId, nonce, raw, hash, oldBroadcastAt],
    );
    await db.query(
      "INSERT INTO job_settlement_gas_attempts(job_id,tx_hash,signed_tx,nonce,broadcast_at,created_at) VALUES($1,$2,$3,$4,$5,$5)",
      [caseData.jobId, hash, raw, nonce, oldBroadcastAt],
    );
    return { hash, raw, nonce };
  }

  try {
    await walletClient.sendTransaction({ to: gasWalletAddress, value: parseEther("50") });

    const eth = await createSettlementCase("eth", parseEther("0.02"));
    await fundEscrow(eth, "eth");
    const ethBefore = await publicClient.getBalance({ address: eth.recipient });
    await processSettlement(eth.jobId);
    expect(await publicClient.getBalance({ address: eth.recipient }) - ethBefore).toBe(eth.amountRaw);
    expect((await db.query<{ status: string }>("SELECT status FROM job_settlements WHERE job_id=$1", [eth.jobId])).rows[0].status).toBe("complete");

    const usdg = await createSettlementCase("usdg", 5_000_000n);
    await fundEscrow(usdg, "usdg");
    await processSettlement(usdg.jobId);
    expect(await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [usdg.recipient] })).toBe(usdg.amountRaw);
    expect((await db.query<{ status: string }>("SELECT status FROM job_settlements WHERE job_id=$1", [usdg.jobId])).rows[0].status).toBe("complete");

    config.GAS_TX_REPLACEMENT_AFTER_SECONDS = 60;
    const replaced = await createSettlementCase("eth", parseEther("0.01"));
    await fundEscrow(replaced, "eth");
    const old = await setOldGasTransaction(replaced, false);
    let replacementHash: Hex | null = null;
    let processError: unknown;
    const processing = processSettlement(replaced.jobId).catch((error) => { processError = error; });
    try {
      for (let i = 0; i < 200; i++) {
        const current = await db.query<{ gas_tx_hash: Hex }>("SELECT gas_tx_hash FROM job_settlements WHERE job_id=$1", [replaced.jobId]);
        if (current.rows[0]?.gas_tx_hash && current.rows[0].gas_tx_hash !== old.hash) {
          try {
            const pending = await publicClient.getTransaction({ hash: current.rows[0].gas_tx_hash });
            if (pending?.hash === current.rows[0].gas_tx_hash) {
              replacementHash = current.rows[0].gas_tx_hash;
              break;
            }
          } catch { /* wait until the replacement reaches the local Anvil pool */ }
        }
        await Bun.sleep(25);
      }
      if (!replacementHash) throw new Error("The replacement transaction was not broadcast to Anvil.");
      await anvilRpc("anvil_mine", [1]);
    } finally {
      await anvilRpc("anvil_setAutomine", [true]);
    }
    await processing;
    if (processError) throw processError;
    const attempts = await db.query<{ tx_hash: Hex; signed_tx: Hex; nonce: string }>(
      "SELECT tx_hash,signed_tx,nonce::text FROM job_settlement_gas_attempts WHERE job_id=$1", [replaced.jobId],
    );
    expect(attempts.rows).toHaveLength(2);
    const original = attempts.rows.find((row) => row.tx_hash === old.hash)!;
    const replacement = attempts.rows.find((row) => row.tx_hash === replacementHash)!;
    expect(replacement.nonce).toBe(original.nonce);
    expect(parseTransaction(replacement.signed_tx).gasPrice!).toBeGreaterThan(parseTransaction(original.signed_tx).gasPrice!);

    const late = await createSettlementCase("eth", parseEther("0.01"));
    await fundEscrow(late, "eth");
    const lateTransaction = await setOldGasTransaction(late, true);
    await processSettlement(late.jobId);
    const lateAttempts = await db.query<{ tx_hash: Hex }>("SELECT tx_hash FROM job_settlement_gas_attempts WHERE job_id=$1", [late.jobId]);
    expect(lateAttempts.rows.map((row) => row.tx_hash)).toEqual([lateTransaction.hash]);
    expect((await db.query<{ status: string }>("SELECT status FROM job_settlements WHERE job_id=$1", [late.jobId])).rows[0].status).toBe("complete");

    const reservePause = await createSettlementCase("eth", parseEther("0.01"));
    await fundEscrow(reservePause, "eth");
    await anvilRpc("anvil_setBalance", [gasWalletAddress, toHex(0n)]);
    const capturedLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values) => capturedLogs.push(values.map(String).join(" "));
    try {
      for (let attempt = 0; attempt < 4; attempt++)
        await expect(processSettlement(reservePause.jobId)).rejects.toThrow("Settlement paused before sponsorship");
    } finally {
      console.error = originalConsoleError;
    }
    expect(capturedLogs.join("\n")).toContain("gas_wallet_below_reserve");
    expect(capturedLogs.join("\n")).toContain("settlement_attempts_exceeded");
    const paused = await db.query<{ attempts: number; error: string; gas_signed_tx: string | null }>(
      "SELECT attempts,error,gas_signed_tx FROM job_settlements WHERE job_id=$1", [reservePause.jobId],
    );
    expect(paused.rows[0].attempts).toBe(4);
    expect(paused.rows[0].error).toContain("before sponsorship");
    expect(paused.rows[0].gas_signed_tx).toBeNull();
    expect((await db.query("SELECT 1 FROM job_settlement_gas_attempts WHERE job_id=$1", [reservePause.jobId])).rowCount).toBe(0);
  } finally {
    await anvilRpc("anvil_setAutomine", [true]).catch(() => undefined);
    if (jobIds.length) {
      await db.query("DELETE FROM job_events WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_settlement_gas_attempts WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_settlements WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM job_escrow_wallets WHERE job_id=ANY($1::uuid[])", [jobIds]);
      await db.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
    }
    if (userIds.length) await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    await db.end();
  }
});
