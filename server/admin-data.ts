import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { auditLogs, ipAccessRules, sharedProviders, siteSettings, visitors } from "../drizzle/schema";
import { decryptAdminSecret, encryptAdminSecret } from "./admin-auth";
import { recordAudit } from "./audit";
import { deviceCanUsePremium, getDeviceAccess, isDeviceProviderPaused, isDeviceProviderRevoked } from "./device-data";
import { getDb } from "./db";
import type { ProviderInput } from "./ai-provider";
import { ENV } from "./_core/env";

export const DEFAULT_SITE = { siteName: "Ai - Cz", tagline: "مختبر الذكاء الخاص بك", description: "مساعدك الذكي الخاص", telegramUsername: "qe_3z", purchaseWhatsapp: "https://wa.me/message/R4J6XXSDMXB6D1", purchaseTelegram: "c5_xc", purchaseMessage: "هل تريد شراء نموذج {model}؟", subscriptionRequired: false, dailyMessageLimit: 20, maintenanceMode: false };

export async function getPublicSiteConfig(code = "", ip = "") {
  const db = await getDb();
  const deviceAccess = code ? await getDeviceAccess(code) : null;
  const deviceState = {
    agentActive: Boolean(deviceAccess?.agentActive),
    agentExpiresAt: deviceAccess?.agentExpiresAt ?? null,
    assigned: deviceAccess?.assigned ?? [],
    revoked: deviceAccess?.revoked ?? [],
    paused: deviceAccess?.paused ?? [],
  };
  if (!db) return { ...DEFAULT_SITE, providers: [] as Array<{ id: string; name: string; kind: string; model: string; endpoint: string; premium: boolean; price: number; description: string; supportsAttachments: boolean; unlocked: boolean }>, device: deviceState };
  const settings = (await db.select().from(siteSettings).where(eq(siteSettings.id, 1)).limit(1))[0];
  const providers = await db.select({ id: sharedProviders.id, name: sharedProviders.name, kind: sharedProviders.kind, model: sharedProviders.model, endpoint: sharedProviders.endpoint, premium: sharedProviders.premium, price: sharedProviders.price, description: sharedProviders.description, publicUntil: sharedProviders.publicUntil, supportsAttachments: sharedProviders.supportsAttachments }).from(sharedProviders).where(eq(sharedProviders.enabled, 1)).orderBy(desc(sharedProviders.createdAt));
  const now = Date.now();
  // Access rules (by IP and/or device fingerprint) also unlock paid models for the visitor.
  const rules = await db.select().from(ipAccessRules);
  const ruleMatches = (providerId: number) =>
    rules.some(rule => matchesAccessRule(rule, providerId, new Date(now)) && ((Boolean(rule.ip) && rule.ip === ip) || (Boolean(code) && rule.code === code)));
  return {
    siteName: settings?.siteName ?? DEFAULT_SITE.siteName,
    tagline: settings?.tagline ?? DEFAULT_SITE.tagline,
    description: settings?.description ?? DEFAULT_SITE.description,
    telegramUsername: settings?.telegramUsername ?? DEFAULT_SITE.telegramUsername,
    purchaseWhatsapp: settings?.purchaseWhatsapp ?? DEFAULT_SITE.purchaseWhatsapp,
    purchaseTelegram: settings?.purchaseTelegram ?? DEFAULT_SITE.purchaseTelegram,
    purchaseMessage: settings?.purchaseMessage ?? DEFAULT_SITE.purchaseMessage,
    subscriptionRequired: Boolean(settings?.subscriptionRequired ?? 0),
    dailyMessageLimit: settings?.dailyMessageLimit ?? DEFAULT_SITE.dailyMessageLimit,
    maintenanceMode: Boolean(settings?.maintenanceMode ?? 0),
    providers: providers.map(provider => ({
      id: `shared-${provider.id}`,
      name: provider.name,
      kind: provider.kind,
      model: provider.model,
      endpoint: provider.endpoint ?? "",
      premium: Boolean(provider.premium),
      price: Number(provider.price ?? 0),
      description: provider.description ?? "",
      supportsAttachments: Boolean(provider.supportsAttachments),
      unlocked: !deviceState.revoked.includes(provider.id) && !deviceState.paused.includes(provider.id) && (!provider.premium || Boolean(provider.publicUntil && provider.publicUntil.getTime() > now) || deviceState.agentActive || deviceState.assigned.includes(provider.id) || ruleMatches(provider.id)),
    })),
    device: deviceState,
  };
}

export async function getAdminSettings() {
  const db = await getDb();
  if (!db) return DEFAULT_SITE;
  const settings = (await db.select().from(siteSettings).where(eq(siteSettings.id, 1)).limit(1))[0];
  return settings ? { siteName: settings.siteName, tagline: settings.tagline, description: settings.description ?? "", telegramUsername: settings.telegramUsername, purchaseWhatsapp: settings.purchaseWhatsapp, purchaseTelegram: settings.purchaseTelegram, purchaseMessage: settings.purchaseMessage, subscriptionRequired: Boolean(settings.subscriptionRequired), dailyMessageLimit: settings.dailyMessageLimit, maintenanceMode: Boolean(settings.maintenanceMode) } : DEFAULT_SITE;
}

export async function updateAdminSettings(input: typeof DEFAULT_SITE) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحفظ الإعدادات");
  const values = { siteName: input.siteName, tagline: input.tagline, description: input.description, telegramUsername: input.telegramUsername.replace(/^@/, ""), purchaseWhatsapp: input.purchaseWhatsapp.trim(), purchaseTelegram: input.purchaseTelegram.replace(/^@/, "").trim(), purchaseMessage: input.purchaseMessage.trim() || DEFAULT_SITE.purchaseMessage, subscriptionRequired: input.subscriptionRequired ? 1 : 0, dailyMessageLimit: Math.max(0, Math.min(100000, Math.floor(input.dailyMessageLimit))), maintenanceMode: input.maintenanceMode ? 1 : 0 };
  await db.insert(siteSettings).values({ id: 1, ...values }).onDuplicateKeyUpdate({ set: values });
  await recordAudit("settings.update", "siteSettings", undefined, JSON.stringify(values));
  return getAdminSettings();
}

export async function listAdminProviders() {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: sharedProviders.id, name: sharedProviders.name, kind: sharedProviders.kind, model: sharedProviders.model, endpoint: sharedProviders.endpoint, enabled: sharedProviders.enabled, premium: sharedProviders.premium, price: sharedProviders.price, description: sharedProviders.description, publicUntil: sharedProviders.publicUntil, supportsAttachments: sharedProviders.supportsAttachments, createdAt: sharedProviders.createdAt }).from(sharedProviders).orderBy(desc(sharedProviders.createdAt));
}

export async function addAdminProvider(input: { name: string; kind: Exclude<ProviderInput["kind"], "demo">; model: string; endpoint?: string; apiKey: string; premium?: boolean; price?: number; description?: string; supportsAttachments?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحفظ المزودين");
  const price = Number.isFinite(input.price) ? Math.max(0, Math.floor(Number(input.price))) : 0;
  const result = await db.insert(sharedProviders).values({ name: input.name, kind: input.kind, model: input.model, endpoint: input.endpoint || null, apiKeyCipher: encryptAdminSecret(input.apiKey), enabled: 1, premium: input.premium ? 1 : 0, price: input.premium ? price : 0, description: input.description?.trim() || null, supportsAttachments: input.supportsAttachments ? 1 : 0 });
  await recordAudit("provider.create", input.name, undefined, JSON.stringify({ kind: input.kind, model: input.model, premium: Boolean(input.premium), price }));
  return Number(result[0].insertId);
}

export async function updateAdminProvider(input: { id: number; name: string; model: string; endpoint?: string; apiKey?: string; enabled?: boolean; premium?: boolean; price?: number; description?: string; supportsAttachments?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحفظ المزودين");
  const set: Record<string, unknown> = { name: input.name, model: input.model, endpoint: input.endpoint || null, enabled: input.enabled === false ? 0 : 1 };
  if (input.premium !== undefined) set.premium = input.premium ? 1 : 0;
  if (input.price !== undefined) set.price = Math.max(0, Math.floor(Number(input.price) || 0));
  if (input.description !== undefined) set.description = input.description.trim() || null;
  if (input.supportsAttachments !== undefined) set.supportsAttachments = input.supportsAttachments ? 1 : 0;
  if (input.apiKey) set.apiKeyCipher = encryptAdminSecret(input.apiKey);
  await db.update(sharedProviders).set(set).where(eq(sharedProviders.id, input.id));
  await recordAudit("provider.update", String(input.id), undefined, JSON.stringify({ enabled: input.enabled, premium: input.premium, price: input.price }));
  return true;
}

export async function deleteAdminProvider(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحذف المزودين");
  await db.delete(sharedProviders).where(eq(sharedProviders.id, id));
  await recordAudit("provider.delete", String(id));
  return true;
}

export async function deleteAllAdminProviders() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحذف المزودين");
  const result = await db.delete(sharedProviders);
  await recordAudit("provider.deleteAll", "all");
  return Number((result as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0);
}

export async function resolveSharedProvider(id: number, allowPremium = false, ip = "", code = "") {
  const db = await getDb();
  if (!db) return null;
  const row = (await db.select().from(sharedProviders).where(and(eq(sharedProviders.id, id), eq(sharedProviders.enabled, 1))).limit(1))[0];
  if (!row) return null;
  // An explicit device revoke always wins, even over IP rules or a public grant.
  if (code && (await isDeviceProviderRevoked(code, id))) return { denied: true as const, reason: "تم إلغاء هذا النموذج لهذا الجهاز. تواصل مع المشرف." };
  // A temporary pause also wins (it blocks until the admin resumes it).
  if (code && (await isDeviceProviderPaused(code, id))) return { denied: true as const, reason: "تم إيقاف هذا النموذج مؤقتًا من المشرف." };
  const publicActive = Boolean(row.publicUntil && row.publicUntil.getTime() > Date.now());
  const allowed = allowPremium || publicActive || (await canUsePremium(ip, id, code)) || (code ? await deviceCanUsePremium(code, id) : false);
  if (row.premium && !allowed) return { denied: true as const, reason: "هذا النموذج مدفوع ويحتاج تصريحًا لهذا العنوان" };
  return { kind: row.kind, model: row.model, endpoint: row.endpoint ?? "", apiKey: decryptAdminSecret(row.apiKeyCipher), sharedProviderId: id, premium: Boolean(row.premium), supportsAttachments: Boolean(row.supportsAttachments) } as ProviderInput & { premium: boolean; supportsAttachments: boolean };
}

export function getClientIp(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: string | null }; ip?: string }, trustProxy = ENV.trustProxy) {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string" && forwarded) {
    // Behind a single trusted edge proxy (Render) the real client address is the LAST hop that
    // the proxy appended. Earlier entries are client-supplied and must never be trusted, otherwise
    // anyone could spoof the admin IP allowlist by sending their own X-Forwarded-For header.
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1].replace(/^::ffff:/, "");
  }
  return (req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

export async function trackVisitor(ip: string, userAgent?: string) {
  const db = await getDb();
  if (!db || !ip || ip === "unknown") return;
  await db.insert(visitors).values({ ip, userAgent: userAgent ?? null, requestCount: 1 }).onDuplicateKeyUpdate({ set: { lastSeen: new Date(), requestCount: sql`${visitors.requestCount} + 1`, userAgent: userAgent ?? null } });
}

export async function isBlockedIp(ip: string) {
  const db = await getDb();
  if (!db) return false;
  const row = (await db.select({ blocked: visitors.blocked }).from(visitors).where(eq(visitors.ip, ip)).limit(1))[0];
  return Boolean(row?.blocked);
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

export function evaluateQuota(limit: number, used: number) {
  return { allowed: limit <= 0 || used < limit, used, remaining: limit <= 0 ? 0 : Math.max(0, limit - used), limit };
}

export async function getQuotaStatus(ip: string) {
  const db = await getDb();
  if (!db) return { allowed: true, used: 0, remaining: 0, limit: 0 };
  const settings = (await db.select({ limit: siteSettings.dailyMessageLimit }).from(siteSettings).where(eq(siteSettings.id, 1)).limit(1))[0];
  const limit = Number(settings?.limit ?? 20);
  const visitor = (await db.select({ messageCount: visitors.messageCount, quotaDate: visitors.quotaDate }).from(visitors).where(eq(visitors.ip, ip)).limit(1))[0];
  const used = visitor?.quotaDate === todayKey() ? Number(visitor.messageCount ?? 0) : 0;
  return evaluateQuota(limit, used);
}

export async function consumeMessageQuota(ip: string) {
  const db = await getDb();
  if (!db) return { allowed: true, used: 0, remaining: 0, limit: 0 };
  await trackVisitor(ip);
  const before = await getQuotaStatus(ip);
  if (!before.allowed) return before;
  const date = todayKey();
  if (before.limit > 0) {
    await db.update(visitors).set({ messageCount: 0, quotaDate: date }).where(and(eq(visitors.ip, ip), sql`(${visitors.quotaDate} <> ${date} OR ${visitors.quotaDate} IS NULL)`));
    await db.update(visitors).set({ messageCount: sql`${visitors.messageCount} + 1`, quotaDate: date }).where(and(eq(visitors.ip, ip), sql`(${visitors.quotaDate} = ${date} OR ${visitors.quotaDate} IS NULL)`));
  } else {
    await db.update(visitors).set({ messageCount: sql`${visitors.messageCount} + 1`, quotaDate: date }).where(eq(visitors.ip, ip));
  }
  const after = await getQuotaStatus(ip);
  return { ...after, allowed: true, used: Math.max(after.used, before.used + 1), remaining: after.limit > 0 ? Math.max(0, after.limit - Math.max(after.used, before.used + 1)) : 0 };
}

export async function canUsePremium(ip: string, providerId: number, code = "", isExplicitlyAllowed = false) {
  if (isExplicitlyAllowed) return true;
  const db = await getDb();
  if (!db) return false;
  // A rule matches the visitor's IP and/or their device fingerprint.
  const conditions = [eq(ipAccessRules.ip, ip)];
  if (code) conditions.push(eq(ipAccessRules.code, code));
  const rules = await db.select().from(ipAccessRules).where(conditions.length > 1 ? or(...conditions) : conditions[0]);
  const now = new Date();
  return rules.some(rule => matchesAccessRule(rule, providerId, now) && (Boolean(rule.ip && rule.ip === ip) || Boolean(code && rule.code === code)));
}

export function matchesAccessRule(rule: { allowAllPremium: number; providerId: number | null; expiresAt: Date | null }, providerId: number, now = new Date()) {
  return (!rule.expiresAt || rule.expiresAt > now) && (Boolean(rule.allowAllPremium) || rule.providerId === providerId);
}

export async function listIpAccessRules() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(ipAccessRules).orderBy(desc(ipAccessRules.createdAt));
}

export async function addIpAccessRule(input: { ip?: string; code?: string; providerId?: number; allowAllPremium: boolean; expiresAt?: Date; note?: string }) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحفظ تصاريح IP");
  const ip = (input.ip ?? "").trim();
  const code = (input.code ?? "").trim() || null;
  if (!ip && !code) throw new Error("أدخل عنوان IP أو بصمة الجهاز");
  const result = await db.insert(ipAccessRules).values({ ip, code, providerId: input.providerId ?? null, allowAllPremium: input.allowAllPremium ? 1 : 0, expiresAt: input.expiresAt ?? null, note: input.note ?? null });
  await recordAudit("ip-rule.create", ip || code || "", ip || code || "", JSON.stringify({ ...input, ip, code }));
  return Number(result[0].insertId);
}

export async function deleteIpAccessRule(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحذف التصريح");
  await db.delete(ipAccessRules).where(eq(ipAccessRules.id, id));
  await recordAudit("ip-rule.delete", String(id));
  return true;
}

export async function adminOverview() {
  const db = await getDb();
  if (!db) return { totalVisitors: 0, activeToday: 0, blockedIps: 0, requests: 0, messagesToday: 0, dailyMessageLimit: 20, auditEvents: 0 };
  const [total] = await db.select({ count: sql<number>`count(*)`, requests: sql<number>`coalesce(sum(${visitors.requestCount}),0)`, messages: sql<number>`coalesce(sum(${visitors.messageCount}),0)` }).from(visitors);
  const [today] = await db.select({ count: sql<number>`count(*)`, messages: sql<number>`coalesce(sum(${visitors.messageCount}),0)` }).from(visitors).where(sql`${visitors.lastSeen} >= ${new Date(Date.now() - 86400000)}`);
  const [blocked] = await db.select({ count: sql<number>`count(*)` }).from(visitors).where(eq(visitors.blocked, 1));
  const [audit] = await db.select({ count: sql<number>`count(*)` }).from(auditLogs);
  const [settings] = await db.select({ limit: siteSettings.dailyMessageLimit }).from(siteSettings).where(eq(siteSettings.id, 1)).limit(1);
  return { totalVisitors: Number(total?.count ?? 0), activeToday: Number(today?.count ?? 0), blockedIps: Number(blocked?.count ?? 0), requests: Number(total?.requests ?? 0), messagesToday: Number(today?.messages ?? 0), dailyMessageLimit: Number(settings?.limit ?? 20), auditEvents: Number(audit?.count ?? 0) };
}

export async function listVisitors() { const db = await getDb(); if (!db) return []; return db.select().from(visitors).orderBy(desc(visitors.lastSeen)).limit(250); }

export async function setIpBlocked(ip: string, blocked: boolean) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لإدارة الحظر");
  await db.insert(visitors).values({ ip, blocked: blocked ? 1 : 0, requestCount: 0 }).onDuplicateKeyUpdate({ set: { blocked: blocked ? 1 : 0 } });
  await recordAudit(blocked ? "visitor.block" : "visitor.unblock", ip, ip);
  return true;
}

export async function listAuditLogs() { const db = await getDb(); if (!db) return []; return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(200); }
export { recordAudit };
