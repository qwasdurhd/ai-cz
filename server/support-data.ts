import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { supportMessages, supportThreads } from "../drizzle/schema";
import { getDb } from "./db";
import { recordAudit } from "./audit";

/** Support conversations are temporary: they stay for 4 hours, then vanish. */
export const SUPPORT_TTL_MS = 4 * 60 * 60 * 1000;

let lastSupportCleanup = 0;

/**
 * Deletes support threads whose last message is older than the 4-hour window.
 * Runs at most once every 5 minutes to avoid hammering the database.
 */
export async function cleanupExpiredSupport(force = false) {
  if (!force && Date.now() - lastSupportCleanup < 5 * 60 * 1000) return 0;
  lastSupportCleanup = Date.now();
  const db = await getDb();
  if (!db) return 0;
  try {
    const cutoff = new Date(Date.now() - SUPPORT_TTL_MS);
    const expired = await db
      .select({ id: supportThreads.id })
      .from(supportThreads)
      .where(sql`coalesce(${supportThreads.lastMessageAt}, ${supportThreads.createdAt}) < ${cutoff}`);
    if (!expired.length) return 0;
    const ids = expired.map(row => row.id);
    await db.delete(supportMessages).where(inArray(supportMessages.threadId, ids));
    await db.delete(supportThreads).where(inArray(supportThreads.id, ids));
    return ids.length;
  } catch {
    return 0;
  }
}

export type SupportMessageItem = { id: number; sender: "user" | "admin"; body: string; createdAt: Date };

export type SupportThreadView = {
  id: number | null;
  code: string;
  messages: SupportMessageItem[];
  unreadForUser: number;
  unreadForAdmin: number;
};

async function ensureThread(code: string, ip?: string, userAgent?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب للدعم الفني");
  const existing = await db.select().from(supportThreads).where(eq(supportThreads.code, code)).limit(1);
  if (existing.length) return existing[0];
  await db.insert(supportThreads).values({ code, ip: ip ?? null, userAgent: userAgent ?? null });
  const created = await db.select().from(supportThreads).where(eq(supportThreads.code, code)).limit(1);
  return created[0];
}

/** Appends a message to the device's support thread, creating it on first contact. */
export async function postSupportMessage(
  code: string,
  sender: "user" | "admin",
  body: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب للدعم الفني");
  const clean = body.trim();
  if (!clean) throw new Error("نص الرسالة مطلوب");
  const thread = await ensureThread(code, meta?.ip, meta?.userAgent);
  await db.insert(supportMessages).values({ threadId: thread.id, sender, body: clean.slice(0, 4000) });
  const patch =
    sender === "user"
      ? { lastMessageAt: new Date(), unreadForAdmin: sql`${supportThreads.unreadForAdmin} + 1` }
      : { lastMessageAt: new Date(), unreadForUser: sql`${supportThreads.unreadForUser} + 1` };
  await db.update(supportThreads).set(patch).where(eq(supportThreads.id, thread.id));
  if (sender === "admin") await recordAudit("support.reply", code, meta?.ip);
  return thread.id;
}

/** Reads a device thread. `viewer` clears the matching unread counter. */
export async function getSupportThread(code: string, viewer: "user" | "admin"): Promise<SupportThreadView> {
  const db = await getDb();
  if (!db || !code) return { id: null, code, messages: [], unreadForUser: 0, unreadForAdmin: 0 };
  const threads = await db.select().from(supportThreads).where(eq(supportThreads.code, code)).limit(1);
  if (!threads.length) return { id: null, code, messages: [], unreadForUser: 0, unreadForAdmin: 0 };
  const thread = threads[0];
  // Expired threads (older than 4 hours) are treated as gone.
  if ((thread.lastMessageAt ?? thread.createdAt).getTime() < Date.now() - SUPPORT_TTL_MS) {
    void cleanupExpiredSupport(true);
    return { id: null, code, messages: [], unreadForUser: 0, unreadForAdmin: 0 };
  }
  const rows = await db.select().from(supportMessages).where(eq(supportMessages.threadId, thread.id)).orderBy(asc(supportMessages.createdAt)).limit(800);
  if (viewer === "user" && thread.unreadForUser > 0) {
    await db.update(supportThreads).set({ unreadForUser: 0 }).where(eq(supportThreads.id, thread.id));
  }
  if (viewer === "admin" && thread.unreadForAdmin > 0) {
    await db.update(supportThreads).set({ unreadForAdmin: 0 }).where(eq(supportThreads.id, thread.id));
  }
  return {
    id: thread.id,
    code,
    messages: rows.map(row => ({ id: row.id, sender: row.sender, body: row.body, createdAt: row.createdAt })),
    unreadForUser: viewer === "user" ? 0 : thread.unreadForUser,
    unreadForAdmin: viewer === "admin" ? 0 : thread.unreadForAdmin,
  };
}

/** Lightweight user-side summary for the floating support button badge. */
export async function supportUserSummary(code: string) {
  const db = await getDb();
  if (!db || !code) return { unread: 0, hasThread: false };
  await cleanupExpiredSupport();
  const threads = await db.select().from(supportThreads).where(eq(supportThreads.code, code)).limit(1);
  if (!threads.length) return { unread: 0, hasThread: false };
  return { unread: threads[0].unreadForUser, hasThread: true };
}

export type SupportThreadRow = {
  id: number;
  code: string;
  ip: string | null;
  userAgent: string | null;
  unreadForAdmin: number;
  unreadForUser: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  lastMessage: string;
  lastSender: "user" | "admin" | null;
  messageCount: number;
};

/** Admin support inbox: all threads with a last-message preview and unread count. */
export async function listSupportThreads(): Promise<SupportThreadRow[]> {
  const db = await getDb();
  if (!db) return [];
  await cleanupExpiredSupport();
  const threads = await db.select().from(supportThreads).orderBy(desc(supportThreads.lastMessageAt), desc(supportThreads.createdAt)).limit(200);
  if (!threads.length) return [];
  // Two queries total (no N+1): pull every message for the visible threads once.
  const ids = threads.map(thread => thread.id);
  const messages = await db
    .select({ threadId: supportMessages.threadId, sender: supportMessages.sender, body: supportMessages.body, createdAt: supportMessages.createdAt })
    .from(supportMessages)
    .where(inArray(supportMessages.threadId, ids))
    .orderBy(desc(supportMessages.createdAt));
  const last = new Map<number, { sender: "user" | "admin"; body: string }>();
  const counts = new Map<number, number>();
  for (const message of messages) {
    if (!last.has(message.threadId)) last.set(message.threadId, { sender: message.sender, body: message.body });
    counts.set(message.threadId, (counts.get(message.threadId) ?? 0) + 1);
  }
  return threads.map(thread => ({
    id: thread.id,
    code: thread.code,
    ip: thread.ip,
    userAgent: thread.userAgent,
    unreadForAdmin: thread.unreadForAdmin,
    unreadForUser: thread.unreadForUser,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
    lastMessage: last.get(thread.id)?.body ?? "",
    lastSender: last.get(thread.id)?.sender ?? null,
    messageCount: counts.get(thread.id) ?? 0,
  }));
}

export async function supportAdminSummary() {
  const db = await getDb();
  if (!db) return { unread: 0, threads: 0 };
  await cleanupExpiredSupport();
  const rows = await db.select({ unread: sql<number>`coalesce(sum(${supportThreads.unreadForAdmin}), 0)`, threads: sql<number>`count(*)` }).from(supportThreads);
  return { unread: Number(rows[0]?.unread ?? 0), threads: Number(rows[0]?.threads ?? 0) };
}

export async function deleteSupportThread(threadId: number, ip?: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(supportMessages).where(eq(supportMessages.threadId, threadId));
  await db.delete(supportThreads).where(eq(supportThreads.id, threadId));
  await recordAudit("support.delete", String(threadId), ip);
}
