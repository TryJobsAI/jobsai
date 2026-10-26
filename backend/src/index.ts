import { app } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { reconcileSettlements } from "./settlement.js";
import { releaseExpiredClaims } from "./jobs.js";

await migrate();
const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`JobsAI API listening on port ${config.PORT}`);
});
const reconciliationTimer = setInterval(() => {
  void reconcileSettlements().catch((error) => console.error("Settlement reconciliation failed:", error));
  void releaseExpiredClaims().catch((error) => console.error("Claim expiry failed:", error));
}, 30_000);
reconciliationTimer.unref();

async function shutdown() {
  clearInterval(reconciliationTimer);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
