import { and, desc, eq, or, sql } from "drizzle-orm";
import { deviceMessages, messageReads } from "../drizzle/schema";
import { getDb } from "./db";
import { recordAudit } from "./audit";

export type MailItem = {
  id: number;
  title: string;
  body: string;
  target: string;
  createdAt: Date;
  read: boolean;
};

export type AdminMailItem = {
  id: number;
  title: string;
  body: string;
  target: string;
  createdAt: Date;
  readCount: number;
};

/** The admin sends a message to a single device code, or to everyone with target "all". */
export async function sendMessage(target: string, title: string, body: string, ip?: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL مطلوب لإرسال البريد");
  const cleanTarget = target === "all" ? "all" : target.trim().slice(0, 40);
  const cleanTitle = title.trim().slice(0, 200) || "رسالة من المشرف";
  const cleanBody = body.trim();
  if (!cleanBody) throw new Error("نص الرسالة مطلوب");
  await db.insert(deviceMessages).values({ target: cleanTarget, title: cleanTitle, body: cleanBody });
  await recordAudit("mail.send", cleanTarget, ip, JSON.stringify({ title: cleanTitle, length: cleanBody.length }));
}

/** Messages visible to one device (direct + broadcast), newest first, with read state. */
export async function listMessagesForDevice(code: string): Promise<MailItem[]> {
  const db = await getDb();
  if (!db || !code) return [];
  const rows = await db
    .select()
    .from(deviceMessages)
    .where(or(eq(deviceMessages.target, code), eq(deviceMessages.target, "all")))
    .orderBy(desc(deviceMessages.createdAt))
    .limit(200);
  const reads = await db.select().from(messageReads).where(eq(messageReads.code, code));
  const readSet = new Set(reads.map(row => row.messageId));
  return rows.map(row => ({ id: row.id, title: row.title, body: row.body, target: row.target, createdAt: row.createdAt, read: readSet.has(row.id) }));
}

export async function unreadMessageCount(code: string) {
  const items = await listMessagesForDevice(code);
  return items.filter(item => !item.read).length;
}

export async function markMessageRead(messageId: number, code: string) {
  const db = await getDb();
  if (!db || !code) return;
  const existing = await db.select().from(messageReads).where(and(eq(messageReads.messageId, messageId), eq(messageReads.code, code))).limit(1);
  if (existing.length === 0) await db.insert(messageReads).values({ messageId, code });
}

/** Admin inbox: every sent message with how many devices have read it. */
export async function listAllMessages(): Promise<AdminMailItem[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(deviceMessages).orderBy(desc(deviceMessages.createdAt)).limit(300);
  const counts = await db.select({ messageId: messageReads.messageId, count: sql<number>`count(*)` }).from(messageReads).groupBy(messageReads.messageId);
  const countMap = new Map(counts.map(row => [row.messageId, Number(row.count)]));
  return rows.map(row => ({ id: row.id, title: row.title, body: row.body, target: row.target, createdAt: row.createdAt, readCount: countMap.get(row.id) ?? 0 }));
}

export async function deleteMessage(id: number, ip?: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(deviceMessages).where(eq(deviceMessages.id, id));
  await db.delete(messageReads).where(eq(messageReads.messageId, id));
  await recordAudit("mail.delete", String(id), ip);
}
