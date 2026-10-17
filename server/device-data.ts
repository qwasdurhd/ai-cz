import { and, desc, eq, sql } from "drizzle-orm";
import { chatConversations, deviceModelUsage, deviceProfiles, deviceProviders, sharedProviders } from "../drizzle/schema";
import { getDb } from "./db";
import { recordAudit } from "./audit";

export type GeoLocation = { country: string | null; region: string | null; city: string | null; latitude: string | null; longitude: string | null; source: string };

export type ProviderGrant = { expiresAt: number | null; at: number; paused?: boolean };
export type ProviderGrants = Record<string, ProviderGrant>;
export type ProviderRevokes = Record<string, { at: number }>;

export type DeviceAccess = {
  code: string;
  exists: boolean;
  agentActive: boolean;
  agentExpiresAt: Date | null;
  assigned: number[];
  revoked: number[];
  paused: number[];
  grants: ProviderGrants;
  revokes: ProviderRevokes;
  banned: boolean;
  banExpiresAt: Date | null;
  banReason: string | null;
};

const CODE_RE = /^[A-Za-z0-9_-]{6,40}$/;

export function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return CODE_RE.test(value) ? value : "";
}

function isLocalIp(ip: string) {
  return !ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip === "::ffff:127.0.0.1";
}

/** Best-effort IP geolocation. Never throws and never blocks the request. */
export async function resolveIpLocation(ip: string): Promise<GeoLocation | null> {
  if (isLocalIp(ip)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = (await response.json()) as { success?: boolean; country?: string; region?: string; city?: string; latitude?: number; longitude?: number };
    if (!data || data.success === false) return null;
    return {
      country: data.country ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      latitude: data.latitude != null ? String(data.latitude) : null,
      longitude: data.longitude != null ? String(data.longitude) : null,
      source: "ip",
    };
  } catch {
    return null;
  }
}

async function reverseGeocode(latitude: number, longitude: number): Promise<GeoLocation | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=ar`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = (await response.json()) as { countryName?: string; principalSubdivision?: string; city?: string; locality?: string };
    return {
      country: data.countryName ?? null,
      region: data.principalSubdivision ?? null,
      city: data.city || data.locality || null,
      latitude: String(latitude),
      longitude: String(longitude),
      source: "gps",
    };
  } catch {
    return null;
  }
}

export async function getDeviceRow(code: string) {
  const db = await getDb();
  if (!db || !code) return null;
  return (await db.select().from(deviceProfiles).where(eq(deviceProfiles.code, code)).limit(1))[0] ?? null;
}

export async function touchDevice(code: string, ip: string, userAgent?: string, options?: { resolveLocation?: boolean }) {
  const db = await getDb();
  if (!db || !code) return null;
  try {
    await db
      .insert(deviceProfiles)
      .values({ code, ip: ip || null, userAgent: userAgent ?? null })
      .onDuplicateKeyUpdate({ set: { lastSeen: new Date(), ip: ip || null, userAgent: userAgent ?? null } });
  } catch {
    return getDeviceRow(code);
  }
  const row = await getDeviceRow(code);
  if (row && options?.resolveLocation && !row.country && ip) {
    const location = await resolveIpLocation(ip);
    if (location) {
      await db
        .update(deviceProfiles)
        .set({ country: location.country, region: location.region, city: location.city, latitude: location.latitude, longitude: location.longitude, locationSource: location.source })
        .where(eq(deviceProfiles.code, code));
      return { ...row, ...location };
    }
  }
  return row;
}

export async function saveGpsLocation(code: string, latitude: number, longitude: number) {
  const db = await getDb();
  if (!db || !code || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  await db.update(deviceProfiles).set({ latitude: String(latitude), longitude: String(longitude), locationSource: "gps" }).where(eq(deviceProfiles.code, code));
  const location = await reverseGeocode(latitude, longitude);
  if (location) {
    await db
      .update(deviceProfiles)
      .set({ country: location.country, region: location.region, city: location.city, latitude: location.latitude, longitude: location.longitude, locationSource: "gps" })
      .where(eq(deviceProfiles.code, code));
  }
  return getDeviceRow(code);
}

export function parseAssigned(raw?: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Parses the per-provider grant map (JSON). Tolerates legacy/array shapes. */
export function parseGrants(raw?: string | null): ProviderGrants {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ProviderGrants = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = positiveId(key);
      if (!id) continue;
      const grant = (value ?? {}) as { expiresAt?: unknown; at?: unknown; paused?: unknown };
      const rawExpiry = grant.expiresAt;
      const expiresAt = rawExpiry == null || rawExpiry === "" ? null : Number(rawExpiry);
      out[String(id)] = {
        expiresAt: expiresAt != null && Number.isFinite(expiresAt) ? expiresAt : null,
        at: Number(grant.at) || Date.now(),
        ...(grant.paused ? { paused: true } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Parses the explicit revoke map (JSON). */
export function parseRevokes(raw?: string | null): ProviderRevokes {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ProviderRevokes = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = positiveId(key);
      if (!id) continue;
      out[String(id)] = { at: Number((value as { at?: unknown })?.at) || Date.now() };
    }
    return out;
  } catch {
    return {};
  }
}

export function isGrantActive(grant: ProviderGrant | undefined | null, now = Date.now()) {
  if (!grant) return false;
  if (grant.paused) return false;
  return grant.expiresAt == null || grant.expiresAt > now;
}

/** Provider ids the device can currently use (legacy array + active grants, minus revokes). */
export function activeAssignedProviderIds(row: { assignedProviders?: string | null; providerGrants?: string | null; providerRevokes?: string | null } | null | undefined): number[] {
  if (!row) return [];
  const revokes = parseRevokes(row.providerRevokes);
  const now = Date.now();
  const ids = new Set<number>(parseAssigned(row.assignedProviders));
  for (const [key, grant] of Object.entries(parseGrants(row.providerGrants))) {
    const id = positiveId(key);
    if (id && isGrantActive(grant, now)) ids.add(id);
  }
  for (const key of Object.keys(revokes)) {
    const id = positiveId(key);
    if (id) ids.delete(id);
  }
  return Array.from(ids);
}


export function isBanActive(row: { banned?: number | null; banExpiresAt?: Date | null } | null | undefined) {
  if (!row?.banned) return false;
  if (row.banExpiresAt && row.banExpiresAt.getTime() <= Date.now()) return false;
  return true;
}

export function isAgentActive(row: { agentEnabled?: number | null; agentExpiresAt?: Date | null } | null | undefined) {
  if (!row?.agentEnabled) return false;
  if (row.agentExpiresAt && row.agentExpiresAt.getTime() <= Date.now()) return false;
  return true;
}

export async function getDeviceAccess(code: string): Promise<DeviceAccess> {
  const row = await getDeviceRow(code);
  const grants = parseGrants(row?.providerGrants);
  return {
    code,
    exists: Boolean(row),
    agentActive: isAgentActive(row),
    agentExpiresAt: row?.agentExpiresAt ?? null,
    assigned: activeAssignedProviderIds(row),
    revoked: Object.keys(parseRevokes(row?.providerRevokes)).map(Number).filter(id => Number.isInteger(id) && id > 0),
    paused: Object.entries(grants).filter(([, grant]) => grant.paused).map(([key]) => Number(key)).filter(id => Number.isInteger(id) && id > 0),
    grants,
    revokes: parseRevokes(row?.providerRevokes),
    banned: isBanActive(row),
    banExpiresAt: row?.banExpiresAt ?? null,
    banReason: row?.banReason ?? null,
  };
}

export async function isDeviceBanned(code: string) {
  if (!code) return false;
  return isBanActive(await getDeviceRow(code));
}

/** True when the admin explicitly revoked this provider for the device (revoke wins). */
export async function isDeviceProviderRevoked(code: string, providerId: number) {
  if (!code) return false;
  const row = await getDeviceRow(code);
  if (!row) return false;
  return Boolean(parseRevokes(row.providerRevokes)[String(providerId)]);
}

/** A device may use a premium model when the admin granted it (with duration) or granted Agent. */
export async function deviceCanUsePremium(code: string, providerId: number) {
  if (!code) return false;
  const row = await getDeviceRow(code);
  if (!row) return false;
  if (parseRevokes(row.providerRevokes)[String(providerId)]) return false;
  // An explicit pause is authoritative: it blocks the model even with Agent access.
  if (parseGrants(row.providerGrants)[String(providerId)]?.paused) return false;
  const grant = parseGrants(row.providerGrants)[String(providerId)];
  if (isGrantActive(grant)) return true;
  if (isAgentActive(row)) return true;
  return parseAssigned(row.assignedProviders).includes(providerId);
}

/** True when the admin paused this model for the device (temporary lock that keeps the remaining time). */
export async function isDeviceProviderPaused(code: string, providerId: number) {
  if (!code) return false;
  const row = await getDeviceRow(code);
  if (!row) return false;
  return Boolean(parseGrants(row.providerGrants)[String(providerId)]?.paused);
}

/**
 * Pauses or resumes a granted model. Pausing keeps the grant and its remaining
 * time but blocks access until the admin resumes it ("فتح").
 */
export async function setDeviceProviderPaused(code: string, providerId: number, paused: boolean, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لإيقاف النماذج");
  const row = await getDeviceRow(code);
  const grants = parseGrants(row?.providerGrants);
  const current = grants[String(providerId)];
  if (!current) throw new Error("لا يوجد اشتراك لهذا النموذج حتى يمكن إيقافه");
  grants[String(providerId)] = { expiresAt: current.expiresAt, at: current.at, ...(paused ? { paused: true } : {}) };
  const grantsJson = JSON.stringify(grants);
  await db.insert(deviceProfiles).values({ code, providerGrants: grantsJson }).onDuplicateKeyUpdate({ set: { providerGrants: grantsJson } });
  await recordAudit(paused ? "device.provider.pause" : "device.provider.resume", code, ip, JSON.stringify({ providerId }));
  return getDeviceRow(code);
}

/** Grants a provider to a device for a duration (null = lifetime). Clears any revoke. */
export async function grantDeviceProvider(code: string, providerId: number, expiresAt: Date | null, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لمنح النماذج");
  const row = await getDeviceRow(code);
  const grants = parseGrants(row?.providerGrants);
  const revokes = parseRevokes(row?.providerRevokes);
  grants[String(providerId)] = { expiresAt: expiresAt ? expiresAt.getTime() : null, at: Date.now() };
  delete revokes[String(providerId)];
  const grantsJson = JSON.stringify(grants);
  const revokesJson = JSON.stringify(revokes);
  await db.insert(deviceProfiles).values({ code, providerGrants: grantsJson, providerRevokes: revokesJson }).onDuplicateKeyUpdate({ set: { providerGrants: grantsJson, providerRevokes: revokesJson } });
  await recordAudit("device.provider.grant", code, ip, JSON.stringify({ providerId, expiresAt: expiresAt ?? null }));
  return getDeviceRow(code);
}

/**
 * Extends an existing grant by `ms` counted from the later of (now, current
 * expiry). `ms === null` turns the grant into a lifetime grant. Works even when
 * the grant already expired. Clears any revoke.
 */
export async function renewDeviceProviderGrant(code: string, providerId: number, ms: number | null, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لتجديد الاشتراكات");
  const row = await getDeviceRow(code);
  const grants = parseGrants(row?.providerGrants);
  const revokes = parseRevokes(row?.providerRevokes);
  const current = grants[String(providerId)];
  let expiresAt: number | null;
  if (ms == null) {
    expiresAt = null;
  } else {
    const base = current?.expiresAt != null && current.expiresAt > Date.now() ? current.expiresAt : Date.now();
    expiresAt = base + Math.max(0, Math.floor(ms));
  }
  grants[String(providerId)] = { expiresAt, at: Date.now() };
  delete revokes[String(providerId)];
  const grantsJson = JSON.stringify(grants);
  const revokesJson = JSON.stringify(revokes);
  await db.insert(deviceProfiles).values({ code, providerGrants: grantsJson, providerRevokes: revokesJson }).onDuplicateKeyUpdate({ set: { providerGrants: grantsJson, providerRevokes: revokesJson } });
  await recordAudit("device.provider.renew", code, ip, JSON.stringify({ providerId, ms, expiresAt }));
  return getDeviceRow(code);
}

/** Removes a grant (legacy array entry too). Does not create a revoke. */
export async function removeDeviceProviderGrant(code: string, providerId: number, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لتعديل النماذج");
  const row = await getDeviceRow(code);
  const grants = parseGrants(row?.providerGrants);
  delete grants[String(providerId)];
  const legacy = parseAssigned(row?.assignedProviders).filter(id => id !== providerId);
  await db
    .insert(deviceProfiles)
    .values({ code, providerGrants: JSON.stringify(grants), assignedProviders: JSON.stringify(legacy) })
    .onDuplicateKeyUpdate({ set: { providerGrants: JSON.stringify(grants), assignedProviders: JSON.stringify(legacy) } });
  await recordAudit("device.provider.ungrant", code, ip, JSON.stringify({ providerId }));
  return getDeviceRow(code);
}

/** Explicitly revokes (or un-revokes) a provider for the device. A revoke beats IP rules. */
export async function setDeviceProviderRevoke(code: string, providerId: number, revoked: boolean, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لإلغاء النماذج");
  const row = await getDeviceRow(code);
  const revokes = parseRevokes(row?.providerRevokes);
  const grants = parseGrants(row?.providerGrants);
  let legacy = parseAssigned(row?.assignedProviders);
  if (revoked) {
    revokes[String(providerId)] = { at: Date.now() };
    delete grants[String(providerId)];
    legacy = legacy.filter(id => id !== providerId);
  } else {
    delete revokes[String(providerId)];
  }
  const set = { providerRevokes: JSON.stringify(revokes), providerGrants: JSON.stringify(grants), assignedProviders: JSON.stringify(legacy) };
  await db.insert(deviceProfiles).values({ code, ...set }).onDuplicateKeyUpdate({ set });
  await recordAudit(revoked ? "device.provider.revoke" : "device.provider.unrevoke", code, ip, JSON.stringify({ providerId }));
  return getDeviceRow(code);
}

export async function setDeviceBan(code: string, banned: boolean, expiresAt?: Date | null, reason?: string | null, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لإدارة الحظر");
  await db
    .insert(deviceProfiles)
    .values({ code, banned: banned ? 1 : 0, banExpiresAt: banned ? expiresAt ?? null : null, banReason: banned ? reason ?? null : null })
    .onDuplicateKeyUpdate({ set: { banned: banned ? 1 : 0, banExpiresAt: banned ? expiresAt ?? null : null, banReason: banned ? reason ?? null : null } });
  await recordAudit(banned ? "device.ban" : "device.unban", code, ip, JSON.stringify({ expiresAt: expiresAt ?? null, reason: reason ?? null }));
  return getDeviceRow(code);
}

export async function setAgentAccess(code: string, enabled: boolean, expiresAt?: Date | null, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لتفعيل الوكيل");
  await db
    .insert(deviceProfiles)
    .values({ code, agentEnabled: enabled ? 1 : 0, agentExpiresAt: enabled ? expiresAt ?? null : null })
    .onDuplicateKeyUpdate({ set: { agentEnabled: enabled ? 1 : 0, agentExpiresAt: enabled ? expiresAt ?? null : null } });
  await recordAudit(enabled ? "device.agent.enable" : "device.agent.disable", code, ip, JSON.stringify({ expiresAt: expiresAt ?? null }));
  return getDeviceRow(code);
}

export async function setAssignedProviders(code: string, providerIds: number[], ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لربط النماذج");
  const clean = Array.from(new Set(providerIds.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)));
  const payload = JSON.stringify(clean);
  await db.insert(deviceProfiles).values({ code, assignedProviders: payload }).onDuplicateKeyUpdate({ set: { assignedProviders: payload } });
  await recordAudit("device.providers.assign", code, ip, payload);
  return getDeviceRow(code);
}

export async function setDeviceNote(code: string, note: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لحفظ الملاحظة");
  await db.insert(deviceProfiles).values({ code, note }).onDuplicateKeyUpdate({ set: { note } });
  return getDeviceRow(code);
}

export async function listDevices() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(deviceProfiles).orderBy(desc(deviceProfiles.lastSeen)).limit(400);
}

export async function listEnabledProviders() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: sharedProviders.id, name: sharedProviders.name, model: sharedProviders.model, kind: sharedProviders.kind, premium: sharedProviders.premium })
    .from(sharedProviders)
    .where(eq(sharedProviders.enabled, 1))
    .orderBy(desc(sharedProviders.createdAt));
}

/**
 * Makes a (paid) model public to everyone until `publicUntil` (null clears it).
 * Used by the "الاشتراكات" section when the admin grants a model to all visitors.
 * Passing `permanent` makes the model permanently free (premium off, no expiry).
 */
export async function setProviderPublic(id: number, publicUntil: Date | null, permanent = false, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لتعديل الاشتراكات");
  const set = permanent
    ? { premium: 0, publicUntil: null }
    : { publicUntil };
  await db.update(sharedProviders).set(set).where(eq(sharedProviders.id, id));
  await recordAudit("provider.public", String(id), ip, JSON.stringify({ publicUntil: publicUntil?.toISOString() ?? null, permanent }));
  return true;
}

// Stores the non-secret metadata of the models a visitor added for themselves.
// The list is replaced on every sync so removed providers disappear too.
export async function reportDeviceProviders(code: string, ip: string, providers: Array<{ name: string; kind: string; model: string; endpoint?: string; supportsAttachments?: boolean }>) {
  const db = await getDb();
  if (!db || !normalizeCode(code)) return false;
  const rows = providers
    .filter(provider => provider && provider.name && provider.model)
    .slice(0, 50)
    .map(provider => ({
      code,
      ip: ip || null,
      name: String(provider.name).slice(0, 120),
      kind: String(provider.kind).slice(0, 24),
      model: String(provider.model).slice(0, 150),
      endpoint: provider.endpoint ? String(provider.endpoint).slice(0, 500) : null,
      supportsAttachments: provider.supportsAttachments ? 1 : 0,
    }));
  await db.delete(deviceProviders).where(eq(deviceProviders.code, code));
  if (rows.length) await db.insert(deviceProviders).values(rows);
  return true;
}

export async function listDeviceProviders() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(deviceProviders).orderBy(desc(deviceProviders.updatedAt)).limit(1000);
}

/* ------------------------- per-model token usage ------------------------- */

/**
 * Adds the token usage of one finished response to the (device, provider)
 * counter. Silent no-op without a database or with empty usage.
 */
export async function incrementDeviceModelUsage(code: string, providerId: number, input: number, output: number) {
  const db = await getDb();
  if (!db || !code || !Number.isInteger(providerId) || providerId <= 0) return;
  const prompt = Math.max(0, Math.floor(Number(input) || 0));
  const completion = Math.max(0, Math.floor(Number(output) || 0));
  if (!prompt && !completion) return;
  try {
    await db
      .insert(deviceModelUsage)
      .values({ code, providerId, promptTokens: prompt, completionTokens: completion, messages: 1 })
      .onDuplicateKeyUpdate({
        set: {
          promptTokens: sql`${deviceModelUsage.promptTokens} + ${prompt}`,
          completionTokens: sql`${deviceModelUsage.completionTokens} + ${completion}`,
          messages: sql`${deviceModelUsage.messages} + 1`,
          lastUsedAt: new Date(),
        },
      });
  } catch {
    /* Usage accounting is best-effort and must never break a chat. */
  }
}

export async function listDeviceModelUsage() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(deviceModelUsage).orderBy(desc(deviceModelUsage.lastUsedAt)).limit(5000);
}

export async function incrementDeviceMessages(code: string) {
  const db = await getDb();
  if (!db || !code) return;
  try {
    await db.insert(deviceProfiles).values({ code, messageCount: 1 }).onDuplicateKeyUpdate({ set: { messageCount: sql`${deviceProfiles.messageCount} + 1`, lastSeen: new Date() } });
  } catch {
    /* ignore */
  }
}

/* ----------------------------- conversations ----------------------------- */

/** 72 hours — conversations auto-expire to keep storage small (e.g. shared hosting). */
export const CONVERSATION_TTL_MS = 72 * 60 * 60 * 1000;

export type StoredMessage = { id: string; role: "user" | "assistant"; content: string; createdAt: number; model?: string; tokens?: number; reasoningDetails?: unknown[] };

export async function saveConversation(input: { code: string; ip?: string; conversationId: string; title: string; mode?: string; messages: StoredMessage[]; tokens?: number }) {
  const db = await getDb();
  if (!db || !input.code || !input.conversationId) return;
  const payload = JSON.stringify(input.messages ?? []);
  const expiresAt = new Date(Date.now() + CONVERSATION_TTL_MS);
  const tokens = Math.max(0, Math.floor(Number(input.tokens) || 0));
  const existing = (await db.select({ id: chatConversations.id }).from(chatConversations).where(and(eq(chatConversations.code, input.code), eq(chatConversations.conversationId, input.conversationId))).limit(1))[0];
  if (existing) {
    await db.update(chatConversations).set({ title: input.title, mode: input.mode ?? "chat", messages: payload, ip: input.ip ?? null, expiresAt, tokens, updatedAt: new Date() }).where(eq(chatConversations.id, existing.id));
  } else {
    await db.insert(chatConversations).values({ code: input.code, ip: input.ip ?? null, conversationId: input.conversationId, title: input.title, mode: input.mode ?? "chat", messages: payload, expiresAt, tokens });
  }
}

export async function deleteExpiredConversations() {
  const db = await getDb();
  if (!db) return 0;
  try {
    const cutoff = new Date(Date.now());
    const legacyCutoff = new Date(Date.now() - CONVERSATION_TTL_MS);
    // Delete rows that expired, plus legacy rows (created before the expiry migration)
    // whose last update is older than the TTL.
    const result = await db.delete(chatConversations).where(sql`(${chatConversations.expiresAt} IS NOT NULL AND ${chatConversations.expiresAt} < ${cutoff}) OR (${chatConversations.expiresAt} IS NULL AND ${chatConversations.updatedAt} < ${legacyCutoff})`);
    return result[0]?.affectedRows ?? 0;
  } catch {
    return 0;
  }
}

export async function listConversations(code: string, limit = 100) {
  const db = await getDb();
  if (!db || !code) return [];
  try { await deleteExpiredConversations(); } catch { /* ignore */ }
  const rows = await db.select().from(chatConversations).where(eq(chatConversations.code, code)).orderBy(desc(chatConversations.updatedAt)).limit(limit);
  return rows.map(row => ({
    id: row.conversationId,
    title: row.title ?? "محادثة بلا عنوان",
    mode: row.mode,
    updatedAt: row.updatedAt.getTime(),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : 0,
    tokens: row.tokens ?? 0,
    messages: safeParseMessages(row.messages),
  }));
}

export async function listAllConversations(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  try { await deleteExpiredConversations(); } catch { /* ignore */ }
  return db
    .select({ id: chatConversations.id, code: chatConversations.code, ip: chatConversations.ip, conversationId: chatConversations.conversationId, title: chatConversations.title, mode: chatConversations.mode, updatedAt: chatConversations.updatedAt, expiresAt: chatConversations.expiresAt, tokens: chatConversations.tokens })
    .from(chatConversations)
    .orderBy(desc(chatConversations.updatedAt))
    .limit(limit);
}

export async function getConversation(id: number) {
  const db = await getDb();
  if (!db) return null;
  const row = (await db.select().from(chatConversations).where(eq(chatConversations.id, id)).limit(1))[0];
  if (!row) return null;
  return { ...row, parsed: safeParseMessages(row.messages) };
}

export async function deleteConversationById(id: number) {
  const db = await getDb();
  if (!db) return false;
  await db.delete(chatConversations).where(eq(chatConversations.id, id));
  return true;
}

export async function deleteConversation(code: string, conversationId: string) {
  const db = await getDb();
  if (!db) return false;
  await db.delete(chatConversations).where(and(eq(chatConversations.code, code), eq(chatConversations.conversationId, conversationId)));
  return true;
}

function safeParseMessages(raw: string): StoredMessage[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(value => value as Partial<StoredMessage>)
      .filter(value => typeof value?.content === "string")
      .map((value, index) => ({
        id: typeof value.id === "string" ? value.id : `m-${index}`,
        role: value.role === "assistant" ? "assistant" : "user",
        content: String(value.content ?? ""),
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        model: typeof value.model === "string" && value.model ? value.model : undefined,
        tokens: typeof value.tokens === "number" && value.tokens > 0 ? value.tokens : undefined,
        reasoningDetails: Array.isArray(value.reasoningDetails) && value.reasoningDetails.length ? value.reasoningDetails : undefined,
      }));
  } catch {
    return [];
  }
}
