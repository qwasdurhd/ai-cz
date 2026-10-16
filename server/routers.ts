import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { callProvider, messagesSchema, providerSchema } from "./ai-provider";
import { clearAdminSession, createAdminSession, isAdminIpAllowed, isAdminRequest } from "./admin-auth";
import {
  addAdminProvider,
  addIpAccessRule,
  adminOverview,
  consumeMessageQuota,
  deleteAdminProvider,
  deleteAllAdminProviders,
  deleteIpAccessRule,
  getAdminSettings,
  getClientIp,
  getPublicSiteConfig,
  getQuotaStatus,
  listAdminProviders,
  listAuditLogs,
  listIpAccessRules,
  listVisitors,
  resolveSharedProvider,
  setIpBlocked,
  updateAdminProvider,
  updateAdminSettings,
} from "./admin-data";
import {
  deleteConversation,
  deleteConversationById,
  getConversation,
  getDeviceAccess,
  grantDeviceProvider,
  listAllConversations,
  listConversations,
  listDeviceModelUsage,
  listDeviceProviders,
  listDevices,
  listEnabledProviders,
  normalizeCode,
  removeDeviceProviderGrant,
  renewDeviceProviderGrant,
  reportDeviceProviders,
  saveConversation,
  saveGpsLocation,
  setAgentAccess,
  setAssignedProviders,
  setDeviceBan,
  setDeviceNote,
  setDeviceProviderPaused,
  setDeviceProviderRevoke,
  setProviderPublic,
  touchDevice,
} from "./device-data";
import { deleteMessage, listAllMessages, listMessagesForDevice, markMessageRead, sendMessage } from "./mail-data";
import { deleteSupportThread, getSupportThread, listSupportThreads, postSupportMessage, supportAdminSummary, supportUserSummary } from "./support-data";

const adminProviderInput = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(["openai", "anthropic", "google", "openrouter", "custom", "czai"]), model: z.string().trim().min(1).max(150), endpoint: z.string().max(500).optional(), apiKey: z.string().min(1).max(500), premium: z.boolean().optional(), price: z.number().int().min(0).max(1000000).optional(), description: z.string().max(1000).optional(), supportsAttachments: z.boolean().optional() });

const chatMessageInput = z.object({ id: z.string().max(64), role: z.enum(["user", "assistant"]), content: z.string().max(120000), createdAt: z.number(), model: z.string().max(150).optional(), tokens: z.number().int().min(0).max(100_000_000).optional() });

function readDeviceCode(req: { headers?: Record<string, unknown> }) {
  const raw = req.headers?.["x-device-code"];
  return normalizeCode(typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "");
}

async function resolveAiProvider(input: z.infer<typeof providerSchema>, ip: string, code: string) {
  if (input.sharedProviderId) {
    const shared = await resolveSharedProvider(input.sharedProviderId, false, ip, code);
    if (!shared) throw new TRPCError({ code: "NOT_FOUND", message: "المزود العام غير متاح" });
    if ("denied" in shared) throw new TRPCError({ code: "FORBIDDEN", message: shared.reason });
    return shared;
  }
  return input;
}

async function enforceChatGuard(ctx: { req: Parameters<typeof getClientIp>[0] }) {
  const config = await getPublicSiteConfig();
  if (config.maintenanceMode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الموقع في وضع الصيانة المؤقتة" });
  const quota = await consumeMessageQuota(getClientIp(ctx.req));
  if (!quota.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `وصلت إلى حد الرسائل اليومي (${quota.limit}). جرّب غدًا.` });
  return quota;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => { const cookieOptions = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 }); return { success: true } as const; }),
  }),
  site: router({
    getConfig: publicProcedure.query(({ ctx }) => getPublicSiteConfig(readDeviceCode(ctx.req), getClientIp(ctx.req))),
    quota: publicProcedure.query(({ ctx }) => getQuotaStatus(getClientIp(ctx.req))),
    // TEMP: raw proxy header diagnostics (removed after deployment verification).
    debugIp: publicProcedure.query(({ ctx }) => {
      const req = ctx.req as unknown as { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string | null } };
      return {
        clientIp: getClientIp(ctx.req),
        xff: String(req.headers["x-forwarded-for"] ?? ""),
        xRealIp: String(req.headers["x-real-ip"] ?? ""),
        forwarded: String(req.headers["forwarded"] ?? ""),
        ip: String(req.ip ?? ""),
        remote: String(req.socket?.remoteAddress ?? ""),
        proxyHeaders: Object.keys(req.headers).filter((h) => h.startsWith("x-") || h.includes("forward") || h.includes("real")),
      };
    }),
  }),
  device: router({
    // Registers the visit, resolves the IP location once, returns current access state.
    sync: publicProcedure.input(z.object({ code: z.string().max(40) })).mutation(async ({ ctx, input }) => {
      const code = normalizeCode(input.code) || readDeviceCode(ctx.req);
      if (!code) return { code: "", agentActive: false, agentExpiresAt: null, assigned: [], banned: false, banExpiresAt: null, banReason: null, exists: false };
      const row = await touchDevice(code, getClientIp(ctx.req), String(ctx.req.headers["user-agent"] ?? ""), { resolveLocation: true });
      const access = await getDeviceAccess(code);
      return { ...access, location: row ? { country: row.country, region: row.region, city: row.city, latitude: row.latitude, longitude: row.longitude, source: row.locationSource } : null };
    }),
    setLocation: publicProcedure.input(z.object({ code: z.string().max(40).optional(), latitude: z.number(), longitude: z.number() })).mutation(async ({ ctx, input }) => {
      const code = normalizeCode(input.code ?? "") || readDeviceCode(ctx.req);
      if (!code) return { success: false as const };
      const row = await saveGpsLocation(code, input.latitude, input.longitude);
      return { success: true as const, location: row ? { country: row.country, region: row.region, city: row.city } : null };
    }),
    // Records the models a visitor added for themselves (metadata only, never the API key).
    reportProviders: publicProcedure
      .input(z.object({ code: z.string().max(40), providers: z.array(z.object({ name: z.string().min(1).max(120), kind: z.string().min(1).max(24), model: z.string().min(1).max(150), endpoint: z.string().max(500).optional(), supportsAttachments: z.boolean().optional() })).max(50) }))
      .mutation(async ({ ctx, input }) => {
        const code = normalizeCode(input.code) || readDeviceCode(ctx.req);
        if (!code) return { success: false as const };
        await reportDeviceProviders(code, getClientIp(ctx.req), input.providers);
        return { success: true as const };
      }),
  }),
  mail: router({
    // The visitor's inbox ("من المشرف"): direct messages plus broadcasts.
    list: publicProcedure.input(z.object({ code: z.string().max(40).optional() }).optional()).query(async ({ ctx, input }) => {
      const code = normalizeCode(input?.code ?? "") || readDeviceCode(ctx.req);
      if (!code) return { messages: [], unread: 0 };
      const messages = await listMessagesForDevice(code);
      return { messages, unread: messages.filter(message => !message.read).length };
    }),
    markRead: publicProcedure.input(z.object({ id: z.number().int().positive(), code: z.string().max(40).optional() })).mutation(async ({ ctx, input }) => {
      const code = normalizeCode(input.code ?? "") || readDeviceCode(ctx.req);
      if (!code) return { success: false as const };
      await markMessageRead(input.id, code);
      return { success: true as const };
    }),
  }),
  support: router({
    // Small badge summary for the floating support button.
    summary: publicProcedure.input(z.object({ code: z.string().max(40).optional() }).optional()).query(async ({ ctx, input }) => {
      const code = normalizeCode(input?.code ?? "") || readDeviceCode(ctx.req);
      if (!code) return { unread: 0, hasThread: false };
      return supportUserSummary(code);
    }),
    thread: publicProcedure.input(z.object({ code: z.string().max(40).optional() }).optional()).query(async ({ ctx, input }) => {
      const code = normalizeCode(input?.code ?? "") || readDeviceCode(ctx.req);
      if (!code) return { id: null, code: "", messages: [], unreadForUser: 0, unreadForAdmin: 0 };
      return getSupportThread(code, "user");
    }),
    send: publicProcedure.input(z.object({ code: z.string().max(40).optional(), body: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
      const code = normalizeCode(input.code ?? "") || readDeviceCode(ctx.req);
      if (!code) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذّر تحديد الجهاز" });
      await postSupportMessage(code, "user", input.body, { ip: getClientIp(ctx.req), userAgent: String(ctx.req.headers["user-agent"] ?? "") });
      return { success: true as const };
    }),
  }),
  chat: router({
    list: publicProcedure.query(async ({ ctx }) => {
      const code = readDeviceCode(ctx.req);
      if (!code) return [];
      return listConversations(code);
    }),
    save: publicProcedure
      .input(z.object({ conversationId: z.string().min(1).max(64), title: z.string().max(255), mode: z.enum(["chat", "agent"]).optional(), messages: z.array(chatMessageInput).max(400), tokens: z.number().int().min(0).max(100_000_000).optional() }))
      .mutation(async ({ ctx, input }) => {
        const code = readDeviceCode(ctx.req);
        if (!code) return { success: false as const };
        await saveConversation({ code, ip: getClientIp(ctx.req), conversationId: input.conversationId, title: input.title, mode: input.mode ?? "chat", messages: input.messages, tokens: input.tokens });
        return { success: true as const };
      }),
    delete: publicProcedure.input(z.object({ conversationId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      const code = readDeviceCode(ctx.req);
      if (!code) return { success: false as const };
      await deleteConversation(code, input.conversationId);
      return { success: true as const };
    }),
  }),
  ai: router({
    chat: publicProcedure.input(z.object({ provider: providerSchema, messages: messagesSchema })).mutation(async ({ ctx, input }) => { const provider = await resolveAiProvider(input.provider, getClientIp(ctx.req), readDeviceCode(ctx.req)); await enforceChatGuard(ctx); return { content: await callProvider(provider, input.messages) }; }),
    verify: publicProcedure.input(z.object({ provider: providerSchema })).mutation(async ({ ctx, input }) => { await callProvider(await resolveAiProvider(input.provider, getClientIp(ctx.req), readDeviceCode(ctx.req)), [{ role: "user", content: "Reply only with OK." }]); return { success: true } as const; }),
  }),
  admin: router({
    session: router({
      me: publicProcedure.query(({ ctx }) => isAdminRequest(ctx.req)),
      myIp: publicProcedure.query(({ ctx }) => ({ ip: getClientIp(ctx.req), allowed: isAdminIpAllowed(getClientIp(ctx.req)) })),
      login: publicProcedure.input(z.object({ password: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => { try { if (!isAdminIpAllowed(getClientIp(ctx.req))) throw new TRPCError({ code: "FORBIDDEN", message: "لوحة الإدارة مقفلة على الشبكات المصرّح لها فقط" }); const success = await createAdminSession(ctx.req, ctx.res, input.password); if (!success) throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة مرور لوحة الإدارة غير صحيحة" }); return { success: true } as const; } catch (error) { if (error instanceof TRPCError) throw error; throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "تعذر فتح جلسة الإدارة" }); } }),
      logout: publicProcedure.mutation(async ({ ctx }) => { await clearAdminSession(ctx.req, ctx.res); return { success: true } as const; }),
    }),
    overview: adminProcedure.query(() => adminOverview()),
    settings: router({
      get: adminProcedure.query(() => getAdminSettings()),
      update: adminProcedure.input(z.object({ siteName: z.string().trim().min(2).max(120), tagline: z.string().trim().min(2).max(255), description: z.string().max(1000), telegramUsername: z.string().trim().min(2).max(120), purchaseWhatsapp: z.string().trim().max(300), purchaseTelegram: z.string().trim().max(120), purchaseMessage: z.string().trim().max(500), subscriptionRequired: z.boolean(), dailyMessageLimit: z.number().int().min(0).max(100000), maintenanceMode: z.boolean() })).mutation(({ input }) => updateAdminSettings(input)),
    }),
    providers: router({
      list: adminProcedure.query(() => listAdminProviders()),
      add: adminProcedure.input(adminProviderInput).mutation(({ input }) => addAdminProvider(input)),
      update: adminProcedure.input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(2).max(120), model: z.string().trim().min(1).max(150), endpoint: z.string().max(500).optional(), apiKey: z.string().max(500).optional(), enabled: z.boolean().optional(), premium: z.boolean().optional(), price: z.number().int().min(0).max(1000000).optional(), description: z.string().max(1000).optional(), supportsAttachments: z.boolean().optional() })).mutation(({ input }) => updateAdminProvider(input)),
      delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) => deleteAdminProvider(input.id)),
      deleteAll: adminProcedure.mutation(() => deleteAllAdminProviders()),
      // "الاشتراكات": make a model public to everyone (with an optional duration).
      setPublic: adminProcedure
        .input(z.object({ id: z.number().int().positive(), publicUntil: z.string().datetime().nullable().optional(), permanent: z.boolean().optional() }))
        .mutation(({ input, ctx }) => setProviderPublic(input.id, input.publicUntil ? new Date(input.publicUntil) : null, Boolean(input.permanent), getClientIp(ctx.req))),
    }),
    visitors: router({ list: adminProcedure.query(() => listVisitors()), setBlocked: adminProcedure.input(z.object({ ip: z.string().min(1).max(64), blocked: z.boolean() })).mutation(({ input }) => setIpBlocked(input.ip, input.blocked)) }),
    accessRules: router({
      list: adminProcedure.query(() => listIpAccessRules()),
      add: adminProcedure.input(z.object({ ip: z.string().max(64).optional(), code: z.string().max(40).optional(), providerId: z.number().int().positive().optional(), allowAllPremium: z.boolean(), expiresAt: z.string().datetime().optional(), note: z.string().max(255).optional() })).mutation(({ input }) => addIpAccessRule({ ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined })),
      delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) => deleteIpAccessRule(input.id)),
    }),
    devices: router({
      list: adminProcedure.query(async () => ({ devices: await listDevices(), providers: await listEnabledProviders(), reportedProviders: await listDeviceProviders(), accessRules: await listIpAccessRules(), usage: await listDeviceModelUsage() })),
      setBan: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), banned: z.boolean(), expiresAt: z.string().datetime().optional(), reason: z.string().max(255).optional() }))
        .mutation(({ input, ctx }) => setDeviceBan(input.code, input.banned, input.expiresAt ? new Date(input.expiresAt) : null, input.reason ?? null, getClientIp(ctx.req))),
      setAgent: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), enabled: z.boolean(), expiresAt: z.string().datetime().optional() }))
        .mutation(({ input, ctx }) => setAgentAccess(input.code, input.enabled, input.expiresAt ? new Date(input.expiresAt) : null, getClientIp(ctx.req))),
      assign: adminProcedure.input(z.object({ code: z.string().min(1).max(40), providerIds: z.array(z.number().int().positive()).max(50) })).mutation(({ input, ctx }) => setAssignedProviders(input.code, input.providerIds, getClientIp(ctx.req))),
      // Grant a single model to a device with an optional duration (no expiresAt = lifetime).
      grant: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), providerId: z.number().int().positive(), expiresAt: z.string().datetime().optional() }))
        .mutation(({ input, ctx }) => grantDeviceProvider(input.code, input.providerId, input.expiresAt ? new Date(input.expiresAt) : null, getClientIp(ctx.req))),
      // Remove a granted model (does not block it).
      ungrant: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), providerId: z.number().int().positive() }))
        .mutation(({ input, ctx }) => removeDeviceProviderGrant(input.code, input.providerId, getClientIp(ctx.req))),
      // Extend the remaining time of a granted model (ms = null keeps it lifetime).
      renew: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), providerId: z.number().int().positive(), ms: z.number().int().min(0).max(100 * 365 * 86400000).nullable() }))
        .mutation(({ input, ctx }) => renewDeviceProviderGrant(input.code, input.providerId, input.ms, getClientIp(ctx.req))),
      // Explicitly revoke (or restore) a model for the device. A revoke beats IP rules.
      revoke: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), providerId: z.number().int().positive(), revoked: z.boolean() }))
        .mutation(({ input, ctx }) => setDeviceProviderRevoke(input.code, input.providerId, input.revoked, getClientIp(ctx.req))),
      // Pause (or resume) a granted model: a temporary lock that keeps the remaining time.
      pause: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), providerId: z.number().int().positive(), paused: z.boolean() }))
        .mutation(({ input, ctx }) => setDeviceProviderPaused(input.code, input.providerId, input.paused, getClientIp(ctx.req))),
      note: adminProcedure.input(z.object({ code: z.string().min(1).max(40), note: z.string().max(255) })).mutation(({ input }) => setDeviceNote(input.code, input.note)),
    }),
    mail: router({
      list: adminProcedure.query(() => listAllMessages()),
      send: adminProcedure
        .input(z.object({ target: z.string().trim().min(1).max(40), title: z.string().trim().max(200).optional(), body: z.string().trim().min(1).max(4000) }))
        .mutation(({ input, ctx }) => sendMessage(input.target, input.title ?? "رسالة من المشرف", input.body, getClientIp(ctx.req))),
      delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input, ctx }) => deleteMessage(input.id, getClientIp(ctx.req))),
    }),
    support: router({
      list: adminProcedure.query(() => listSupportThreads()),
      summary: adminProcedure.query(() => supportAdminSummary()),
      thread: adminProcedure.input(z.object({ code: z.string().min(1).max(40) })).query(({ input }) => getSupportThread(input.code, "admin")),
      reply: adminProcedure
        .input(z.object({ code: z.string().min(1).max(40), body: z.string().trim().min(1).max(4000) }))
        .mutation(({ input, ctx }) => postSupportMessage(input.code, "admin", input.body, { ip: getClientIp(ctx.req) })),
      delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input, ctx }) => deleteSupportThread(input.id, getClientIp(ctx.req))),
    }),
    chats: router({
      list: adminProcedure.query(() => listAllConversations()),
      get: adminProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getConversation(input.id)),
      delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) => deleteConversationById(input.id)),
    }),
    audit: router({ list: adminProcedure.query(() => listAuditLogs()) }),
  }),
});

export type AppRouter = typeof appRouter;
