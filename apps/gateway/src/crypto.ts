import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * SHA-256 for high-entropy secrets (API keys, session tokens, invite tokens).
 * These are 256-bit random values, so a slow KDF adds nothing: brute force is infeasible,
 * and a fast hash allows an indexed lookup by hash.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const API_KEY_PREFIX = "ugw_";

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + randomToken(32);
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

// Passwords are low-entropy, so they get a memory-hard KDF.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

/**
 * AES-256-GCM envelope for upstream credentials stored in Postgres.
 * The server id is bound in as additional authenticated data, so a ciphertext copied
 * onto another server row fails to decrypt instead of leaking a credential to it.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("credential key must be 32 bytes");
  }

  encrypt(plaintext: string, serverId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(serverId));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(envelope: string, serverId: string): string {
    const [version, ivB64, tagB64, ctB64] = envelope.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("unknown credential format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAAD(Buffer.from(serverId));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }
}
