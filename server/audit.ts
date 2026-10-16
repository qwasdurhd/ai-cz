import { auditLogs } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Shared audit writer.
 * Kept in its own module so both admin-data and device-data can use it
 * without creating a circular import between them.
 */
export async function recordAudit(action: string, target?: string, ip?: string, details?: string) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(auditLogs).values({ action, target: target ?? null, ip: ip ?? null, details: details ?? null });
  } catch {
    /* auditing must never break the request */
  }
}
