import { config } from "./config.js";

export type OpsAlertEvent = "gas_wallet_below_reserve" | "settlement_attempts_exceeded" | "gas_transaction_replaced";
export type OpsAlertDetails = Record<string, string | number>;
type AlertDependencies = {
  webhookUrl?: string | null;
  fetcher?: typeof fetch;
  log?: (...values: unknown[]) => void;
};

export async function sendOpsAlert(event: OpsAlertEvent, details: OpsAlertDetails, dependencies: AlertDependencies = {}) {
  const payload = {
    source: "jobsai-backend",
    event,
    occurredAt: new Date().toISOString(),
    ...details,
  };
  const log = dependencies.log ?? console.error;
  log("[jobsai-ops-alert]", JSON.stringify(payload));

  const webhookUrl = dependencies.webhookUrl === undefined ? config.OPS_ALERT_WEBHOOK_URL : dependencies.webhookUrl;
  if (!webhookUrl) return;

  try {
    const response = await (dependencies.fetcher ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) log("[jobsai-ops-alert] webhook returned an error", response.status);
  } catch (error) {
    log("[jobsai-ops-alert] webhook delivery failed", String(error).slice(0, 300));
  }
}
