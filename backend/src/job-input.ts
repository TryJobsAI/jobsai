import { parseUnits } from "viem";
import { z } from "zod";
import { ApiError } from "./http.js";

export const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/, "Enter a plain decimal amount.");

export const createJobInputSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  asset: z.enum(["eth", "usdg"]),
  amount: amountSchema,
});

export const submissionInputSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  deliverable: z.string().trim().min(1).max(100_000),
  evidence: z.array(z.string().url().max(2_000)).max(20).default([]),
});

export function parseJobAmount(asset: "eth" | "usdg", value: string, usdgDecimals: number) {
  const precision = asset === "eth" ? 18 : usdgDecimals;
  if (!amountSchema.safeParse(value).success || (value.split(".")[1]?.length ?? 0) > precision)
    throw new ApiError(400, "invalid_amount", `The ${asset.toUpperCase()} amount has too many decimal places or an invalid format.`);
  let amount: bigint;
  try {
    amount = parseUnits(value, precision);
  } catch {
    throw new ApiError(400, "invalid_amount", `The ${asset.toUpperCase()} amount has too many decimal places.`);
  }
  if (amount <= 0n) throw new ApiError(400, "invalid_amount", "The job amount must be greater than zero.");
  return amount;
}

export function assertMinimumJobAmount(amount: bigint, minimum: bigint, asset: "eth" | "usdg") {
  if (amount < minimum) throw new ApiError(400, "amount_below_minimum", `The minimum job amount has not been met for ${asset.toUpperCase()}.`);
}

export function parseDeadline(value: unknown, now = new Date()): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "invalid_deadline", "deadlineAt must be a valid future date.");
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime()) || deadline <= now)
    throw new ApiError(400, "invalid_deadline", "deadlineAt must be a valid future date.");
  return deadline;
}
