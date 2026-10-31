import { encodeFunctionData, erc20Abi, keccak256, parseTransaction, type Address, type Hash, type Hex } from "viem";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { gasAccount, gasWalletAddress, loadEscrowAccount, publicClient } from "./escrow.js";
import { sendOpsAlert } from "./ops-alerts.js";

type Settlement = {
  id: string; job_id: string; outcome: "pay_doer" | "refund_client"; recipient: Address;
  amount_raw: string; status: string; phase: string; gas_nonce: string | null;
  gas_signed_tx: Hex | null; gas_tx_hash: Hash | null; payout_nonce: string | null;
  gas_broadcast_at: Date | null;
  payout_signed_tx: Hex | null; payout_tx_hash: Hash | null; sweep_nonce: string | null;
  sweep_signed_tx: Hex | null; sweep_tx_hash: Hash | null; asset: "eth" | "usdg";
  token_address: Address | null; escrow_address: Address; encrypted_private_key: string;
};

export function buildPayoutTransaction(settlement: Pick<Settlement, "asset" | "recipient" | "amount_raw" | "token_address">) {
  return {
    to: settlement.asset === "eth" ? settlement.recipient : settlement.token_address!,
    value: settlement.asset === "eth" ? BigInt(settlement.amount_raw) : 0n,
    data: settlement.asset === "eth" ? "0x" as Hex : encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [settlement.recipient, BigInt(settlement.amount_raw)],
    }),
  };
}

export function gasLimitWithBuffer(estimatedGas: bigint, bufferBps = 2_000n) {
  if (estimatedGas <= 0n || bufferBps < 0n) throw new Error("Gas estimate must be positive and buffer non-negative.");
  return (estimatedGas * (10_000n + bufferBps) + 9_999n) / 10_000n;
}

export function escrowGasReserve(gasPrice: bigint, gasTopUpLimit: bigint, payoutGasLimit: bigint, sweepGasLimit: bigint) {
  return gasPrice * (gasTopUpLimit + payoutGasLimit + sweepGasLimit) * 2n;
}

export function gasWalletRequiredBalance(sponsorshipValue: bigint, gasPrice: bigint, gasLimit: bigint) {
  return sponsorshipValue + gasPrice * gasLimit;
}

async function assertGasWalletCanCover(jobId: string, value: bigint, gasPrice: bigint, gasLimit: bigint) {
  const required = gasWalletRequiredBalance(value, gasPrice, gasLimit);
  const balance = await publicClient.getBalance({ address: gasWalletAddress });
  if (balance >= required) return;
  await sendOpsAlert("gas_wallet_insufficient_balance", { jobId, balanceWei: balance.toString(), requiredWei: required.toString() });
  throw new Error("Gas wallet balance is below the calculated transaction requirement. Settlement will retry with backoff.");
}

export function settlementRetryDelaySeconds(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Settlement attempt must be a positive integer.");
  return Math.min(30 * 2 ** (attempt - 1), 300);
}

export function replacementGasPrice(previousPrice: bigint, networkPrice: bigint, bumpBps = 2_000n) {
  if (previousPrice <= 0n || networkPrice <= 0n || bumpBps < 1n) throw new Error("Replacement gas prices and bump must be positive.");
  const bumpedPrevious = (previousPrice * (10_000n + bumpBps) + 9_999n) / 10_000n;
  return bumpedPrevious > networkPrice ? bumpedPrevious : networkPrice;
}

export function escrowSweepAmount(balance: bigint, gasPrice: bigint, sweepGasLimit: bigint) {
  const amount = balance - gasPrice * sweepGasLimit;
  return amount > 0n ? amount : 0n;
}

const waitFor = async (hash: Hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: config.RH_CONFIRMATIONS });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
  return receipt;
};

async function sendPersisted(raw: Hex, hash: Hash) {
  try { await publicClient.sendRawTransaction({ serializedTransaction: raw }); }
  catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes("already known") && !message.includes("known transaction") && !message.includes("nonce too low")) throw error;
  }
  return waitFor(hash);
}

async function load(jobId: string) {
  const result = await db.query<Settlement>(
    `SELECT s.*,j.asset,j.token_address,ew.address AS escrow_address,ew.encrypted_private_key
     FROM job_settlements s JOIN jobs j ON j.id=s.job_id JOIN job_escrow_wallets ew ON ew.job_id=j.id
     WHERE s.job_id=$1`, [jobId]);
  return result.rows[0];
}

async function signAndPersist(jobId: string, stage: "gas" | "payout" | "sweep", tx: Record<string, unknown>, account: any) {
  const nonceColumn = `${stage}_nonce`;
  const signedColumn = `${stage}_signed_tx`;
  const hashColumn = `${stage}_tx_hash`;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73301822)");
    const current = await client.query<any>(`SELECT ${nonceColumn},${signedColumn},${hashColumn} FROM job_settlements WHERE job_id=$1 FOR UPDATE`, [jobId]);
    if (current.rows[0][signedColumn]) {
      await client.query("COMMIT");
      return { raw: current.rows[0][signedColumn] as Hex, hash: current.rows[0][hashColumn] as Hash };
    }
    const pending = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const previous = stage === "gas"
      ? await client.query<{ next_nonce: string | null }>(`SELECT (MAX(gas_nonce)+1)::text AS next_nonce FROM job_settlements WHERE gas_nonce IS NOT NULL`)
      : await client.query<{ next_nonce: string | null }>(
          `SELECT (GREATEST(COALESCE(payout_nonce,-1),COALESCE(sweep_nonce,-1))+1)::text AS next_nonce FROM job_settlements WHERE job_id=$1`, [jobId]);
    const nonce = Math.max(pending, previous.rows[0].next_nonce ? Number(previous.rows[0].next_nonce) : 0);
    const raw = await account.signTransaction({ ...tx, nonce, chainId: config.RH_CHAIN_ID, type: "legacy" });
    const hash = keccak256(raw);
    await client.query(`UPDATE job_settlements SET ${nonceColumn}=$2,${signedColumn}=$3,${hashColumn}=$4,updated_at=now() WHERE job_id=$1`,
      [jobId, nonce, raw, hash]);
    if (stage === "gas") {
      await client.query(
        "INSERT INTO job_settlement_gas_attempts(job_id,tx_hash,signed_tx,nonce) VALUES($1,$2,$3,$4)",
        [jobId, hash, raw, nonce],
      );
    }
    await client.query("COMMIT");
    return { raw: raw as Hex, hash };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function ensureStageTx(settlement: Settlement, stage: "gas" | "payout" | "sweep", tx: Record<string, unknown>, account: any) {
  const existingRaw = settlement[`${stage}_signed_tx`];
  if (existingRaw) return { raw: existingRaw, hash: settlement[`${stage}_tx_hash`]! };
  return signAndPersist(settlement.job_id, stage, tx, account);
}

async function findMinedGasAttempt(jobId: string) {
  const attempts = await db.query<{ tx_hash: Hash }>(
    "SELECT tx_hash FROM job_settlement_gas_attempts WHERE job_id=$1 ORDER BY created_at DESC", [jobId],
  );
  for (const attempt of attempts.rows) {
    let receipt;
    try { receipt = await publicClient.getTransactionReceipt({ hash: attempt.tx_hash }); }
    catch { continue; }
    if (receipt.status !== "success") throw new Error(`Gas sponsorship transaction ${attempt.tx_hash} reverted.`);
    return waitFor(attempt.tx_hash);
  }
  return null;
}

async function replaceStuckGasTransaction(settlement: Settlement, current: { raw: Hex; hash: Hash }) {
  const confirmed = await findMinedGasAttempt(settlement.job_id);
  if (confirmed) return { transaction: current, confirmed: true };
  if (!settlement.gas_broadcast_at || Date.now() - settlement.gas_broadcast_at.getTime() < config.GAS_TX_REPLACEMENT_AFTER_SECONDS * 1_000)
    return { transaction: current, confirmed: false };

  const parsed = parseTransaction(current.raw);
  if (parsed.type !== "legacy" || parsed.gasPrice === undefined || parsed.to === null || parsed.gas === undefined || parsed.nonce === undefined)
    throw new Error("The persisted gas transaction cannot be safely repriced.");
  const networkPrice = (await publicClient.getGasPrice()) * 3n / 2n;
  const gasPrice = replacementGasPrice(parsed.gasPrice, networkPrice);
  await assertGasWalletCanCover(settlement.job_id, parsed.value ?? 0n, gasPrice, parsed.gas);

  const raw = await gasAccount.signTransaction({
    to: parsed.to,
    value: parsed.value ?? 0n,
    data: parsed.data,
    gas: parsed.gas,
    gasPrice,
    nonce: Number(parsed.nonce),
    chainId: config.RH_CHAIN_ID,
    type: "legacy",
  });
  const hash = keccak256(raw);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73301822)");
    const currentRow = await client.query<{ gas_signed_tx: Hex; gas_tx_hash: Hash }>(
      "SELECT gas_signed_tx,gas_tx_hash FROM job_settlements WHERE job_id=$1 FOR UPDATE", [settlement.job_id],
    );
    if (!currentRow.rows[0]) throw new Error("The settlement disappeared while replacing its gas transaction.");
    if (currentRow.rows[0].gas_tx_hash !== current.hash) {
      await client.query("COMMIT");
      return { transaction: { raw: currentRow.rows[0].gas_signed_tx, hash: currentRow.rows[0].gas_tx_hash }, confirmed: false };
    }
    await client.query(
      "UPDATE job_settlements SET gas_signed_tx=$2,gas_tx_hash=$3,gas_broadcast_at=NULL,updated_at=now() WHERE job_id=$1",
      [settlement.job_id, raw, hash],
    );
    await client.query(
      "INSERT INTO job_settlement_gas_attempts(job_id,tx_hash,signed_tx,nonce) VALUES($1,$2,$3,$4)",
      [settlement.job_id, hash, raw, Number(parsed.nonce)],
    );
    await client.query("COMMIT");
    await sendOpsAlert("gas_transaction_replaced", {
      jobId: settlement.job_id,
      nonce: Number(parsed.nonce),
      previousHash: current.hash,
      replacementHash: hash,
    });
    return { transaction: { raw: raw as Hex, hash }, confirmed: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function sendGasTransaction(jobId: string, transaction: { raw: Hex; hash: Hash }) {
  const parsed = parseTransaction(transaction.raw);
  if (parsed.type !== "legacy" || parsed.gasPrice === undefined || parsed.gas === undefined)
    throw new Error("The persisted gas transaction cannot be checked against the gas wallet balance.");
  await assertGasWalletCanCover(jobId, parsed.value ?? 0n, parsed.gasPrice, parsed.gas);
  await db.query("UPDATE job_settlement_gas_attempts SET broadcast_at=COALESCE(broadcast_at,now()) WHERE tx_hash=$1", [transaction.hash]);
  await db.query("UPDATE job_settlements SET gas_broadcast_at=COALESCE(gas_broadcast_at,now()),updated_at=now() WHERE job_id=$1", [jobId]);
  try { await publicClient.sendRawTransaction({ serializedTransaction: transaction.raw }); }
  catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("nonce too low")) {
      const mined = await findMinedGasAttempt(jobId);
      if (mined) return mined;
      throw error;
    }
    if (!message.includes("already known") && !message.includes("known transaction")) throw error;
  }
  return waitFor(transaction.hash);
}

export async function processSettlement(jobId: string) {
  const lease = await db.query(
    `UPDATE job_settlements SET lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
     WHERE job_id=$1 AND status='pending' AND (lease_until IS NULL OR lease_until<now()) RETURNING id,attempts`, [jobId]);
  if (!lease.rowCount) return;
  const attempt = Number(lease.rows[0].attempts);
  if (attempt === 4)
    void sendOpsAlert("settlement_attempts_exceeded", { jobId, attempts: attempt });
  try {
    let settlement = await load(jobId);
    if (!settlement) throw new Error("Settlement record is missing.");
    const escrow = loadEscrowAccount(jobId, settlement.encrypted_private_key);
    const gasPrice = (await publicClient.getGasPrice()) * 3n / 2n;
    const payoutRequest = buildPayoutTransaction(settlement);
    const [gasTopUpEstimate, payoutEstimate, sweepEstimate] = await Promise.all([
      settlement.gas_signed_tx ? null : publicClient.estimateGas({ account: gasAccount.address, to: settlement.escrow_address as Address, value: 0n }),
      settlement.payout_signed_tx ? null : publicClient.estimateGas({ account: escrow.address, ...payoutRequest }),
      settlement.sweep_signed_tx ? null : publicClient.estimateGas({ account: escrow.address, to: gasWalletAddress, value: 0n }),
    ]);
    const gasTopUpLimit = gasTopUpEstimate === null ? null : gasLimitWithBuffer(gasTopUpEstimate);
    const payoutGasLimit = payoutEstimate === null ? null : gasLimitWithBuffer(payoutEstimate);
    const sweepGasLimit = sweepEstimate === null ? null : gasLimitWithBuffer(sweepEstimate);

    {
      const reserve = settlement.gas_signed_tx ? 0n : escrowGasReserve(
        gasPrice,
        gasTopUpLimit!,
        payoutGasLimit!,
        sweepGasLimit!,
      );
      const sponsorLock = await db.connect();
      try {
        await sponsorLock.query("SELECT pg_advisory_lock(73301823)");
        if (!settlement.gas_signed_tx) {
          await assertGasWalletCanCover(jobId, reserve, gasPrice, gasTopUpLimit!);
        }
        const gasTx = await ensureStageTx(settlement, "gas", {
          to: settlement.escrow_address, value: reserve, gas: gasTopUpLimit ?? 1n, gasPrice,
        }, gasAccount);
        const replacement = await replaceStuckGasTransaction(settlement, gasTx);
        if (!replacement.confirmed) await sendGasTransaction(jobId, replacement.transaction);
      } finally {
        await sponsorLock.query("SELECT pg_advisory_unlock(73301823)").catch(() => undefined);
        sponsorLock.release();
      }
      await db.query("UPDATE job_settlements SET phase='payout',updated_at=now() WHERE job_id=$1", [jobId]);
    }

    settlement = await load(jobId);
    {
      const payout = await ensureStageTx(settlement, "payout", {
        ...buildPayoutTransaction(settlement),
        gas: payoutGasLimit ?? 1n,
        gasPrice,
      }, escrow);
      await sendPersisted(payout.raw, payout.hash);
      await db.query("UPDATE job_settlements SET phase='sweep',updated_at=now() WHERE job_id=$1", [jobId]);
    }

    settlement = await load(jobId);
    if (settlement.sweep_signed_tx && settlement.sweep_tx_hash) {
      await sendPersisted(settlement.sweep_signed_tx, settlement.sweep_tx_hash);
    } else {
      const balance = await publicClient.getBalance({ address: settlement.escrow_address });
      const sweepValue = escrowSweepAmount(balance, gasPrice, sweepGasLimit!);
      if (sweepValue > 0n) {
        const sweep = await ensureStageTx(settlement, "sweep", {
          to: gasWalletAddress, value: sweepValue, gas: sweepGasLimit ?? 1n, gasPrice,
        }, escrow);
        await sendPersisted(sweep.raw, sweep.hash);
      }
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE job_settlements SET status='complete',phase='complete',lease_until=NULL,error=NULL,updated_at=now() WHERE job_id=$1", [jobId]);
      await client.query("UPDATE jobs SET status=$2,settled_at=now(),updated_at=now() WHERE id=$1 AND status='settlement_pending'", [jobId, settlement.outcome === "pay_doer" ? "completed" : "refunded"]);
      await client.query("INSERT INTO job_events (job_id,event_type,details) VALUES ($1,'job.settled',$2)", [jobId, JSON.stringify({ outcome: settlement.outcome, recipient: settlement.recipient, payoutTransaction: settlement.payout_tx_hash })]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } catch (error) {
    const retryDelay = settlementRetryDelaySeconds(attempt);
    await db.query("UPDATE job_settlements SET lease_until=now()+($3::int*interval '1 second'),error=$2,updated_at=now() WHERE job_id=$1", [jobId, String(error).slice(0, 2_000), retryDelay]);
    throw error;
  }
}

export async function reconcileSettlements() {
  const result = await db.query<{ job_id: string }>(
    `SELECT job_id FROM job_settlements WHERE status='pending' AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 20`);
  for (const row of result.rows) void processSettlement(row.job_id).catch((error) => console.error(`Settlement ${row.job_id} retry failed:`, error));
}
