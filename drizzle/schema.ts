import { int, mediumtext, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const siteSettings = mysqlTable("siteSettings", {
  id: int("id").primaryKey().default(1),
  siteName: varchar("siteName", { length: 120 }).notNull().default("Ai - Cz"),
  tagline: varchar("tagline", { length: 255 }).notNull().default("مختبر الذكاء الخاص بك"),
  description: text("description"),
  telegramUsername: varchar("telegramUsername", { length: 120 }).notNull().default("qe_3z"),
  // Purchase contact shown inside the "buy a paid model" dialog. Editable by the admin.
  purchaseWhatsapp: varchar("purchaseWhatsapp", { length: 300 }).notNull().default("https://wa.me/message/R4J6XXSDMXB6D1"),
  purchaseTelegram: varchar("purchaseTelegram", { length: 120 }).notNull().default("c5_xc"),
  purchaseMessage: varchar("purchaseMessage", { length: 500 }).notNull().default("هل تريد شراء نموذج {model}؟"),
  subscriptionRequired: int("subscriptionRequired").notNull().default(0),
  dailyMessageLimit: int("dailyMessageLimit").notNull().default(20),
  maintenanceMode: int("maintenanceMode").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const sharedProviders = mysqlTable("sharedProviders", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  kind: mysqlEnum("kind", ["openai", "anthropic", "google", "openrouter", "custom", "czai"]).notNull(),
  model: varchar("model", { length: 150 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  apiKeyCipher: text("apiKeyCipher").notNull(),
  enabled: int("enabled").notNull().default(1),
  premium: int("premium").notNull().default(0),
  // Price in USD shown in the purchase dialog for paid models (0 = free / not set).
  price: int("price").notNull().default(0),
  // Short description shown in the purchase dialog next to the price.
  description: text("description"),
  // When set to a future date, the (paid) model is public to everyone until then.
  // The admin uses this from the "الاشتراكات" section to give a model to all
  // visitors for a limited duration. null = not public.
  publicUntil: timestamp("publicUntil"),
  supportsAttachments: int("supportsAttachments").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const visitors = mysqlTable("visitors", {
  id: int("id").autoincrement().primaryKey(),
  ip: varchar("ip", { length: 64 }).notNull().unique(),
  userAgent: text("userAgent"),
  firstSeen: timestamp("firstSeen").defaultNow().notNull(),
  lastSeen: timestamp("lastSeen").defaultNow().onUpdateNow().notNull(),
  requestCount: int("requestCount").notNull().default(1),
  blocked: int("blocked").notNull().default(0),
  messageCount: int("messageCount").notNull().default(0),
  quotaDate: varchar("quotaDate", { length: 10 }),
});

export const ipAccessRules = mysqlTable("ipAccessRules", {
  id: int("id").autoincrement().primaryKey(),
  // The rule can target an IP ("ip") and/or a device fingerprint ("code").
  // Either one may be empty; a rule matches when the value it holds matches.
  ip: varchar("ip", { length: 64 }).notNull().default(""),
  code: varchar("code", { length: 40 }),
  providerId: int("providerId"),
  allowAllPremium: int("allowAllPremium").notNull().default(0),
  expiresAt: timestamp("expiresAt"),
  note: varchar("note", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  action: varchar("action", { length: 80 }).notNull(),
  target: varchar("target", { length: 160 }),
  ip: varchar("ip", { length: 64 }),
  details: text("details"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const adminSessions = mysqlTable("adminSessions", {
  id: int("id").autoincrement().primaryKey(),
  token: varchar("token", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Per-device profile keyed by a stable, literal device code (fingerprint).
// The admin controls bans and Agent access from this table.
export const deviceProfiles = mysqlTable("deviceProfiles", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  ip: varchar("ip", { length: 64 }),
  userAgent: text("userAgent"),
  country: varchar("country", { length: 96 }),
  region: varchar("region", { length: 96 }),
  city: varchar("city", { length: 96 }),
  latitude: varchar("latitude", { length: 32 }),
  longitude: varchar("longitude", { length: 32 }),
  locationSource: varchar("locationSource", { length: 24 }),
  messageCount: int("messageCount").notNull().default(0),
  agentEnabled: int("agentEnabled").notNull().default(0),
  agentExpiresAt: timestamp("agentExpiresAt"),
  banned: int("banned").notNull().default(0),
  banExpiresAt: timestamp("banExpiresAt"),
  banReason: varchar("banReason", { length: 255 }),
  assignedProviders: text("assignedProviders"),
  // Per-provider grants with an explicit duration.
  // JSON: { [providerId]: { expiresAt: number | null; at: number } } (null = lifetime)
  providerGrants: text("providerGrants"),
  // Providers the admin explicitly revoked for this device.
  // A revoke always wins over IP rules and Agent access.
  // JSON: { [providerId]: { at: number } }
  providerRevokes: text("providerRevokes"),
  note: varchar("note", { length: 255 }),
  firstSeen: timestamp("firstSeen").defaultNow().notNull(),
  lastSeen: timestamp("lastSeen").defaultNow().onUpdateNow().notNull(),
});

// Server-side conversation history keyed by device code (per-IP visitors get
// their chats restored silently). Admin can read them.
export const chatConversations = mysqlTable("chatConversations", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull(),
  ip: varchar("ip", { length: 64 }),
  conversationId: varchar("conversationId", { length: 64 }).notNull(),
  title: varchar("title", { length: 255 }),
  mode: varchar("mode", { length: 16 }).notNull().default("chat"),
  messages: mediumtext("messages").notNull(),
  // Conversations auto-expire 72 hours after the last save to save storage.
  expiresAt: timestamp("expiresAt"),
  // Total tokens (input + output) spent on this conversation, updated from
  // provider usage data the client accumulates while streaming.
  tokens: int("tokens").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type SiteSettings = typeof siteSettings.$inferSelect;
export type SharedProvider = typeof sharedProviders.$inferSelect;
export type Visitor = typeof visitors.$inferSelect;
export type DeviceProfile = typeof deviceProfiles.$inferSelect;
export type ChatConversationRow = typeof chatConversations.$inferSelect;

// Providers a visitor added themselves with their own API key. Only non-secret
// metadata is reported to the server (never the key) so the admin can audit who
// added what. Rows are replaced on each sync for the device code.
export const deviceProviders = mysqlTable("deviceProviders", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull(),
  ip: varchar("ip", { length: 64 }),
  name: varchar("name", { length: 120 }).notNull(),
  kind: varchar("kind", { length: 24 }).notNull(),
  model: varchar("model", { length: 150 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  supportsAttachments: int("supportsAttachments").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DeviceProvider = typeof deviceProviders.$inferSelect;

// Token usage per device per shared model, so the admin "الاشتراكات" panel can
// show how many tokens each granted model consumed for each person.
// Incremented server-side while a shared provider streams (chat or Agent).
export const deviceModelUsage = mysqlTable("deviceModelUsage", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull(),
  providerId: int("providerId").notNull(),
  promptTokens: int("promptTokens").notNull().default(0),
  completionTokens: int("completionTokens").notNull().default(0),
  messages: int("messages").notNull().default(0),
  firstUsedAt: timestamp("firstUsedAt").defaultNow().notNull(),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("deviceModelUsage_code_provider_uq").on(table.code, table.providerId)]);

export type DeviceModelUsage = typeof deviceModelUsage.$inferSelect;

// One-way messages the admin sends to visitors ("من المشرف").
// target is a device code, or "all" for a broadcast. Read state is per device.
export const deviceMessages = mysqlTable("deviceMessages", {
  id: int("id").autoincrement().primaryKey(),
  target: varchar("target", { length: 40 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: mediumtext("body").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Per-device read receipts for messages (a broadcast has no single reader).
export const messageReads = mysqlTable("messageReads", {
  id: int("id").autoincrement().primaryKey(),
  messageId: int("messageId").notNull(),
  code: varchar("code", { length: 40 }).notNull(),
  readAt: timestamp("readAt").defaultNow().notNull(),
});

// Live support threads (one per device) with two-way messages.
export const supportThreads = mysqlTable("supportThreads", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  ip: varchar("ip", { length: 64 }),
  userAgent: text("userAgent"),
  unreadForAdmin: int("unreadForAdmin").notNull().default(0),
  unreadForUser: int("unreadForUser").notNull().default(0),
  lastMessageAt: timestamp("lastMessageAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const supportMessages = mysqlTable("supportMessages", {
  id: int("id").autoincrement().primaryKey(),
  threadId: int("threadId").notNull(),
  sender: mysqlEnum("sender", ["user", "admin"]).notNull(),
  body: mediumtext("body").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DeviceMessage = typeof deviceMessages.$inferSelect;
export type MessageRead = typeof messageReads.$inferSelect;
export type SupportThread = typeof supportThreads.$inferSelect;
export type SupportMessage = typeof supportMessages.$inferSelect;
