import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().optional(),
);

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().url(),
    RH_CHAIN_ID: z.coerce.number().int().refine((value) => [4663, 46630].includes(value)),
    RH_RPC_URL: z.string().url(),
    USDG_TOKEN_ADDRESS: optionalString.pipe(
      z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    ),
    USDG_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
    RH_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(2),
    MAX_ACTIVE_CLAIMS_PER_WALLET: z.coerce.number().int().min(1).max(100).default(2),
    CLAIM_EXPIRY_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PAUSE_NEW_WORK: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    OPS_ALERT_WEBHOOK_URL: optionalString.pipe(z.string().url().optional()),
    MIN_JOB_ETH_AMOUNT: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/).default("0.001"),
    MIN_JOB_USDG_AMOUNT: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/).default("1"),
    AUTH_DOMAIN: z.string().min(1).default("www.tryjobsai.com"),
    AUTH_URI: z.string().url().default("https://www.tryjobsai.com"),
    AUTH_TOKEN_PEPPER: z.string().min(32),
    DATA_ENCRYPTION_KEY: z.string().min(32),
    TEAM_WALLET_ADDRESSES: z.string().default(""),
    JOBSAI_TEAM_PASSWORD: optionalString,
    GAS_WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    GAS_WALLET_MIN_BALANCE_WEI: z.string().regex(/^\d+$/).default("5000000000000000"),
    GAS_TX_REPLACEMENT_AFTER_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
    CRON_SECRET: z.string().min(32),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
    CLOUDINARY_URL: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
    CLOUDINARY_CLOUD_NAME: optionalString,
    GROQ_API_KEY: optionalString,
    JOB_DRAFT_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
  })
  .parse(process.env);

if (env.DATA_ENCRYPTION_KEY === env.AUTH_TOKEN_PEPPER) {
  throw new Error("DATA_ENCRYPTION_KEY must differ from AUTH_TOKEN_PEPPER.");
}

export const config = env;
export const teamWallets = new Set(
  env.TEAM_WALLET_ADDRESSES.split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean),
);
