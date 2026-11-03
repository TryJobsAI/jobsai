import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { assertPublicWebhookTarget, assertWebhookUrlShape, isPrivateAddress, signWebhookPayload, webhookInputSchema } from "../src/webhooks.js";

describe("webhook safety and signing", () => {
  test("private, loopback, link-local, and mapped addresses are refused", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"])
      expect(isPrivateAddress(address)).toBe(true);
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])
      expect(isPrivateAddress(address)).toBe(false);
  });

  test("only public https URLs on port 443 are accepted", () => {
    expect(assertWebhookUrlShape("https://hooks.example.com/jobsai")).toBeNull();
    expect(assertWebhookUrlShape("http://hooks.example.com/jobsai")).toBe("https_required");
    expect(assertWebhookUrlShape("https://user:pass@hooks.example.com")).toBe("credentials_not_allowed");
    expect(assertWebhookUrlShape("https://hooks.example.com:8080/")).toBe("port_not_allowed");
    expect(assertWebhookUrlShape("https://localhost/hook")).toBe("private_host");
    expect(assertWebhookUrlShape("https://metadata.internal/")).toBe("private_host");
    expect(assertWebhookUrlShape("https://169.254.169.254/latest")).toBe("private_host");
    expect(assertWebhookUrlShape("https://[::1]/")).toBe("private_host");
    expect(webhookInputSchema.safeParse({ url: "http://hooks.example.com" }).success).toBe(false);
    expect(webhookInputSchema.safeParse({ url: "https://hooks.example.com", events: ["job.paid", "job.paid"] }).success).toBe(false);
    expect(webhookInputSchema.parse({ url: "https://hooks.example.com" }).events).toEqual([]);
  });

  test("a hostname that resolves to a private address is refused at send time", async () => {
    await expect(assertPublicWebhookTarget("https://hooks.example.com/x", async () => [{ address: "93.184.216.34", family: 4 }])).resolves.toBeUndefined();
    await expect(assertPublicWebhookTarget("https://rebind.example.com/x", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]))
      .rejects.toMatchObject({ code: "webhook_url_not_allowed" });
    await expect(assertPublicWebhookTarget("https://missing.example.com/x", async () => [])).rejects.toMatchObject({ code: "webhook_host_unresolved" });
  });

  test("signatures are Stripe-style HMAC-SHA256 over the timestamp and raw body", () => {
    const body = JSON.stringify({ id: "evt", type: "job.paid" });
    const header = signWebhookPayload("whsec_test", 1_767_225_600, body);
    expect(header).toBe(`t=1767225600,v1=${createHmac("sha256", "whsec_test").update(`1767225600.${body}`).digest("hex")}`);
    expect(signWebhookPayload("whsec_other", 1_767_225_600, body)).not.toBe(header);
  });
});
