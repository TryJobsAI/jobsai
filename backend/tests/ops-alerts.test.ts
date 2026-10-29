import { describe, expect, test } from "bun:test";
import { sendOpsAlert } from "../src/ops-alerts.js";

describe("operational alerts", () => {
  test("logs and posts a structured alert to the configured webhook", async () => {
    let postedUrl = "";
    let postedPayload: any;
    const log: unknown[][] = [];
    await sendOpsAlert("gas_transaction_replaced", { jobId: "job-1", nonce: 7, previousHash: "0xold", replacementHash: "0xnew" }, {
      webhookUrl: "https://alerts.example.test/jobsai",
      fetcher: async (input, init) => {
        postedUrl = String(input);
        postedPayload = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
      log: (...values) => log.push(values),
    });
    expect(postedUrl).toBe("https://alerts.example.test/jobsai");
    expect(postedPayload).toMatchObject({ source: "jobsai-backend", event: "gas_transaction_replaced", jobId: "job-1", nonce: 7 });
    expect(log).toHaveLength(1);
  });

  test("reports webhook failure without interrupting a settlement", async () => {
    const log: unknown[][] = [];
    await expect(sendOpsAlert("settlement_attempts_exceeded", { jobId: "job-2", attempts: 4 }, {
      webhookUrl: "https://alerts.example.test/jobsai",
      fetcher: async () => new Response(null, { status: 503 }),
      log: (...values) => log.push(values),
    })).resolves.toBeUndefined();
    expect(log).toHaveLength(2);
    expect(log[1]).toContain(503);
  });
});
