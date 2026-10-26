import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1),
  /** Public base URL of the dashboard + gateway, used for invite links and the MCP URL shown to users. */
  PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  /** base64 of 32 random bytes; encrypts upstream credentials at rest (AES-256-GCM). */
  CREDENTIALS_KEY: z.string().min(1),
  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default("Admin"),

  /** JSON array of servers registered on first start; see seed.ts. */
  SEED_SERVERS: z.string().optional(),

  /** Comma-separated hostnames (exact or *.suffix) allowed to resolve to private addresses. */
  UPSTREAM_PRIVATE_HOSTS: z.string().default(""),
  UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  UPSTREAM_LIST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  UPSTREAM_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HEALTH_INTERVAL_MS: z.coerce.number().int().min(0).default(10_000),

  RATE_LIMIT_MCP_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),

  LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  /** OpenAI-compatible base URL (Groq, OpenAI, OpenRouter, Ollama...). */
  LLM_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  LLM_MODEL: z.string().default("openai/gpt-oss-120b"),
  LLM_API_KEY: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CHAT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  /** Above this many tools the agent gets search_tools/call_tool instead of every tool. */
  CHAT_MAX_DIRECT_TOOLS: z.coerce.number().int().min(1).default(40),
  STORE_TIMEZONE: z.string().default("UTC"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const key = Buffer.from(parsed.data.CREDENTIALS_KEY, "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_KEY must be base64 of exactly 32 bytes");
  return parsed.data;
}
