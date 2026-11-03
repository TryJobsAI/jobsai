import { app } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { reconcileSettlements } from "./settlement.js";
import { releaseExpiredClaims } from "./jobs.js";
import { deliverWebhooks } from "./webhooks.js";

await migrate();
const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`JobsAI API listening on port ${config.PORT}`);
});
const reconciliationTimer = setInterval(() => {
  void reconcileSettlements().catch((error) => console.error("Settlement reconciliation failed:", error));
  void releaseExpiredClaims().catch((error) => console.error("Claim expiry failed:", error));
}, 30_000);
reconciliationTimer.unref();
const webhookTimer = setInterval(() => {
  void deliverWebhooks().catch((error) => console.error("Webhook delivery failed:", error));
}, 10_000);
webhookTimer.unref();

async function shutdown() {
  clearInterval(reconciliationTimer);
  clearInterval(webhookTimer);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
