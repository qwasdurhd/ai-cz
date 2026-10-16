import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import fs from "node:fs";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { messagesSchema, providerSchema, streamProvider, type TokenUsage } from "../ai-provider";
import { runAgent } from "../agent";
import { serveAnswerPdf, serveConversationPdf } from "../pdf";
import { consumeMessageQuota, getClientIp, getPublicSiteConfig, isBlockedIp, resolveSharedProvider, trackVisitor } from "../admin-data";
import { deleteExpiredConversations, getDeviceAccess, incrementDeviceMessages, incrementDeviceModelUsage, isDeviceBanned, normalizeCode, touchDevice } from "../device-data";
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

function readHeaderCode(headers: Record<string, unknown>) {
  const raw = headers["x-device-code"];
  return normalizeCode(typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "");
}

/** Reject a request; tRPC clients get a proper error envelope, others a simple message. */
function deny(req: express.Request, res: express.Response, status: number, message: string) {
  if (req.path.startsWith("/trpc")) {
    return res.status(status).json({ error: { json: { message, code: -32003, data: { code: "FORBIDDEN", httpStatus: status } } } });
  }
  return res.status(status).json({ error: message });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  if (ENV.trustProxy) app.set("trust proxy", true);
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api", async (req, res, next) => {
    if (req.path.startsWith("/admin")) return next();
    const ip = getClientIp(req);
    const code = readHeaderCode(req.headers as Record<string, unknown>);
    // The control panel must always stay reachable so an admin can lift a ban or
    // an IP block even from the very device/browser that was banned.
    const routePath = (req.originalUrl || req.url || "").split("?")[0];
    if (routePath.includes("/trpc/admin")) return next();
    try {
      await trackVisitor(ip, req.headers["user-agent"]);
      if (await isBlockedIp(ip)) return deny(req, res, 403, "تم حظر هذا العنوان من استخدام الموقع");
      if (code) {
        await touchDevice(code, ip, req.headers["user-agent"]);
        if (await isDeviceBanned(code)) return deny(req, res, 403, "تم حظر هذا الجهاز من استخدام الموقع. تواصل مع المشرف.");
      }
      next();
    } catch {
      next();
    }
  });
  app.post("/api/ai/pdf", async (req, res) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title : "Ai - Cz · إجابة";
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      await serveAnswerPdf(res, { title, content });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : "تعذر إنشاء PDF" });
    }
  });
  // Export the whole conversation to one PDF (Arabic, shaped, with model names).
  app.post("/api/ai/pdf/conversation", async (req, res) => {
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const clean = messages
        .map((message: unknown) => {
          const value = message as { id?: unknown; role?: unknown; content?: unknown; createdAt?: unknown; model?: unknown; tokens?: unknown };
          if (typeof value?.content !== "string") return null;
          return {
            id: typeof value.id === "string" ? value.id : "",
            role: value.role === "assistant" ? "assistant" : "user",
            content: value.content.slice(0, 120000),
            createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
            model: typeof value.model === "string" ? value.model.slice(0, 150) : undefined,
            tokens: typeof value.tokens === "number" && value.tokens > 0 ? Math.floor(value.tokens) : undefined,
          };
        })
        .filter(Boolean);
      await serveConversationPdf(res, {
        title: typeof req.body?.title === "string" ? req.body.title : "محادثة Ai - Cz",
        mode: req.body?.mode === "agent" ? "agent" : "chat",
        tokens: typeof req.body?.tokens === "number" ? req.body.tokens : 0,
        messages: clean,
      });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : "تعذر إنشاء PDF" });
    }
  });
  app.post("/api/ai/stream", async (req, res) => {
    try {
      const providerInput = providerSchema.parse(req.body?.provider);
      const ip = getClientIp(req);
      const code = readHeaderCode(req.headers as Record<string, unknown>);
      const config = await getPublicSiteConfig(code);
      if (config.maintenanceMode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الموقع في وضع الصيانة المؤقتة" });
      const provider = providerInput.sharedProviderId ? await resolveSharedProvider(providerInput.sharedProviderId, false, ip, code) : providerInput;
      if (!provider) return res.status(404).json({ error: "المزود العام غير متاح" });
      if ("denied" in provider) throw new TRPCError({ code: "FORBIDDEN", message: provider.reason });
      const quota = await consumeMessageQuota(ip);
      if (!quota.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `وصلت إلى حد الرسائل اليومي (${quota.limit}). جرّب غدًا.` });
      const messages = messagesSchema.parse(req.body?.messages);
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      let usage: TokenUsage | undefined;
      for await (const chunk of streamProvider(provider, messages, { onUsage: value => { usage = value; } })) {
        res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
      }
      if (usage && (usage.input || usage.output)) {
        res.write(`data: ${JSON.stringify({ type: "usage", input: usage.input, output: usage.output })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      if (code) await incrementDeviceMessages(code);
      if (code && providerInput.sharedProviderId && usage) await incrementDeviceModelUsage(code, providerInput.sharedProviderId, usage.input, usage.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر بدء البث";
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      } else {
        res.status(400).json({ error: message });
      }
    }
  });
  // Agent mode: real tool-calling loop (web search, fetch, calculator, datetime).
  app.post("/api/ai/agent", async (req, res) => {
    try {
      const providerInput = providerSchema.parse(req.body?.provider);
      const ip = getClientIp(req);
      const code = readHeaderCode(req.headers as Record<string, unknown>);
      const config = await getPublicSiteConfig(code);
      if (config.maintenanceMode) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الموقع في وضع الصيانة المؤقتة" });
      if (!code) throw new TRPCError({ code: "FORBIDDEN", message: "تعذّر التعرف على الجهاز" });
      const access = await getDeviceAccess(code);
      if (!access.agentActive) throw new TRPCError({ code: "FORBIDDEN", message: "ميزة Agent غير مفعّلة لهذا الجهاز. فعّلها من لوحة الإدارة أو اطلب من المشرف." });
      const provider = providerInput.sharedProviderId ? await resolveSharedProvider(providerInput.sharedProviderId, false, ip, code) : providerInput;
      if (!provider) return res.status(404).json({ error: "المزود العام غير متاح" });
      if ("denied" in provider) throw new TRPCError({ code: "FORBIDDEN", message: provider.reason });
      if (provider.kind !== "demo" && !provider.apiKey) throw new TRPCError({ code: "BAD_REQUEST", message: "أضف مفتاح API حقيقيًا لتشغيل الوكيل" });
      const quota = await consumeMessageQuota(ip);
      if (!quota.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `وصلت إلى حد الرسائل اليومي (${quota.limit}). جرّب غدًا.` });
      const messages = messagesSchema.parse(req.body?.messages);
      const maxSteps = Number(req.body?.maxSteps) || 5;
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      let agentUsage: TokenUsage | undefined;
      for await (const event of runAgent(provider, messages, { maxSteps })) {
        if (event.type === "usage") agentUsage = { input: event.input, output: event.output };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      await incrementDeviceMessages(code);
      if (providerInput.sharedProviderId && agentUsage) await incrementDeviceModelUsage(code, providerInput.sharedProviderId, agentUsage.input, agentUsage.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر تشغيل الوكيل";
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      } else {
        res.status(400).json({ error: message });
      }
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // Conversations auto-expire after 72 hours; sweep them to keep storage small.
  const CONVERSATION_SWEEP_MS = 10 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    deleteExpiredConversations().catch(() => undefined);
  }, CONVERSATION_SWEEP_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

startServer().catch(console.error);
