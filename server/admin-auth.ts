import crypto from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import { adminSessions } from "../drizzle/schema";
import { getDb } from "./db";
import { ENV } from "./_core/env";

export const ADMIN_COOKIE = "ai_cz_admin";

// Ciphertext layout: [version(1)] [iv(12)] [authTag(16)] [ciphertext…], base64url.
// v3 = strongest KDF (scrypt N=2^16), written for every NEW secret.
// v2 was also scrypt but with N=2^15, kept so nothing already stored breaks.
// v1 was a bare unsalted SHA-256, kept only to read very old rows.
const SECRET_VERSION = 3;
const SECRET_VERSION_V2 = 2;
const SECRET_SALT = "ai-cz.provider-key.v3";
const SECRET_SALT_V2 = "ai-cz.provider-key.v2";

// Key derivation is the expensive part, so it is computed once per process.
const keyCache = new Map<number, Buffer>();
function derivedKey(version: number) {
  const cached = keyCache.get(version);
  if (cached) return cached;
  const secret = ENV.adminSecret || "change-this-admin-secret";
  const salt = version === SECRET_VERSION ? SECRET_SALT : SECRET_SALT_V2;
  const N = version === SECRET_VERSION ? 2 ** 16 : 2 ** 15;
  const key = crypto.scryptSync(secret, salt, 32, { N, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  keyCache.set(version, key);
  return key;
}

// Legacy v1 key: a single unsalted SHA-256 (kept only to read old rows).
function legacyKey() {
  return crypto.createHash("sha256").update(ENV.adminSecret || "change-this-admin-secret").digest();
}

export function encryptAdminSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey(SECRET_VERSION), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([SECRET_VERSION]), iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function decryptAdminSecret(payload: string) {
  try {
    const raw = Buffer.from(payload, "base64url");
    if (raw.length > 29 && (raw[0] === SECRET_VERSION || raw[0] === SECRET_VERSION_V2)) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey(raw[0]), raw.subarray(1, 13));
      decipher.setAuthTag(raw.subarray(13, 29));
      return Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString("utf8");
    }
    // Legacy v1: [iv(12)] [authTag(16)] [ciphertext…].
    const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Control-panel IP allowlist
// ---------------------------------------------------------------------------

/** Parse a rules string into a clean list of IPs/CIDRs. */
export function parseAllowlist(raw: string = ENV.adminAllowedIps) {
  return (raw || "")
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

/** The configured allowlist rules (exact IPs and IPv4 CIDRs). Empty = allow all. */
export function adminAllowlist() {
  return parseAllowlist();
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function ruleMatches(ip: string, rule: string) {
  const bare = ip.replace(/^::ffff:/, "");
  if (rule === ip || rule === bare) return true;
  if (!rule.includes("/")) return false;
  const [base, bitsRaw] = rule.split("/");
  const bits = Number(bitsRaw);
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(bare);
  if (baseInt == null || ipInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isLoopbackIp(ip: string) {
  const bare = ip.replace(/^::ffff:/, "");
  return bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}

/**
 * True when the given client IP may reach the control panel.
 * When the rule list is empty the panel is reachable from anywhere (still
 * password protected). Loopback is always allowed so local development can
 * never lock you out.
 */
export function ipInAllowlist(ip: string, rules: string[]) {
  if (rules.length === 0) return true;
  if (!ip || ip === "unknown") return false;
  if (isLoopbackIp(ip)) return true;
  return rules.some(rule => ruleMatches(ip, rule));
}

export function isAdminIpAllowed(ip: string) {
  return ipInAllowlist(ip, adminAllowlist());
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export async function isAdminRequest(req: Request) {
  // Cache the check on the request object: tRPC batches several admin
  // procedures into one HTTP request, and without this each one opens its own
  // adminSessions query, which can overload a small connection pool.
  const cache = req as Request & { __adminAuth?: Promise<boolean> };
  if (cache.__adminAuth) return cache.__adminAuth;
  const pending = (async () => {
    const token = readCookie(req, ADMIN_COOKIE);
    if (!token) return false;
    const db = await getDb();
    if (!db) return false;
    const rows = await db.select({ id: adminSessions.id }).from(adminSessions).where(and(eq(adminSessions.token, token), gt(adminSessions.expiresAt, new Date()))).limit(1);
    return rows.length > 0;
  })();
  cache.__adminAuth = pending;
  return pending;
}

export async function createAdminSession(req: Request, res: Response, password: string) {
  if (!ENV.adminPassword || password.length !== ENV.adminPassword.length || !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ENV.adminPassword))) return false;
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لتشغيل لوحة الإدارة");
  const token = crypto.randomBytes(32).toString("hex");
  await db.insert(adminSessions).values({ token, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14) });
  res.cookie(ADMIN_COOKIE, token, { httpOnly: true, secure: req.protocol === "https" || req.headers["x-forwarded-proto"] === "https", sameSite: "lax", path: "/", maxAge: 1000 * 60 * 60 * 24 * 14 });
  return true;
}

export async function clearAdminSession(req: Request, res: Response) {
  const token = readCookie(req, ADMIN_COOKIE);
  const db = await getDb();
  if (db && token) await db.delete(adminSessions).where(eq(adminSessions.token, token));
  res.clearCookie(ADMIN_COOKIE, { httpOnly: true, secure: req.protocol === "https" || req.headers["x-forwarded-proto"] === "https", sameSite: "lax", path: "/" });
}
