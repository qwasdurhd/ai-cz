import { TRPCError } from "@trpc/server";
import type { AttachmentInput, ChatInput, ProviderInput, TokenUsage } from "./ai-provider";

/**
 * Real, server-side tools for Agent mode.
 * Everything the agent can do goes through these executors.
 */
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type AgentEvent =
  | { type: "status"; tool: string; label: string }
  | { type: "tool"; tool: string; summary: string }
  | { type: "chunk"; content: string }
  | { type: "usage"; input: number; output: number }
  | { type: "error"; message: string }
  | { type: "done" };

const AGENT_SYSTEM = [
  "أنت «Cz Agent»، وكيل تنفيذي داخل موقع Ai - Cz. تفكر بخطوات، وتستخدم الأدوات المتاحة فعليًا للحصول على معلومة حقيقية قبل الإجابة.",
  "قواعد العمل:",
  "1. إن احتجت معلومة حديثة أو خارج معرفتك، استخدم web_search ثم web_fetch لقراءة المصدر.",
  "2. استخدم calculator لكل حساب رقمي، وcurrent_datetime لأي سؤال عن الوقت أو التاريخ.",
  "3. لا تخترع مصادر أو أرقامًا. إن فشلت أداة، اذكر ذلك بصراحة واقترح بديلًا.",
  "4. نظّم الإجابة بالعربية بخطوات واضحة، وأضف روابط المصادر التي قرأتها.",
  "5. لا تطلب معلومات حساسة، ولا تعد بما لا تستطيع تنفيذه.",
].join("\n");

type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[] };

const TOOL_DEFS: Array<{ name: string; description: string; parameters: JsonSchema; label: string }> = [
  {
    name: "web_search",
    label: "أبحث في الويب",
    description: "ابحث في الويب عن أحدث المعلومات. يعيد قائمة نتائج (عنوان، رابط، مقتطف).",
    parameters: { type: "object", properties: { query: { type: "string", description: "نص البحث" } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    label: "أقرأ صفحة",
    description: "افتح رابطًا واقرأ محتواه النصي. استخدمها بعد البحث لقراءة المصدر كاملًا.",
    parameters: { type: "object", properties: { url: { type: "string", description: "رابط الصفحة الكامل" } }, required: ["url"] },
  },
  {
    name: "calculator",
    label: "أحسب رقميًا",
    description: "احسب تعبيرًا رياضيًا بدقة. يدعم + - * / % ^ والأقواس والدوال sqrt, abs, round, sin, cos, tan, log, ln, min, max, pow والثوابت pi, e.",
    parameters: { type: "object", properties: { expression: { type: "string", description: "التعبير الرياضي مثل: (12.5*4)/3 + sqrt(81)" } }, required: ["expression"] },
  },
  {
    name: "current_datetime",
    label: "أتحقق من الوقت",
    description: "يعيد التاريخ والوقت الحالي بالتفصيل.",
    parameters: { type: "object", properties: { timezone: { type: "string", description: "المنطقة الزمنية (اختياري)، مثال: Asia/Riyadh" } }, required: [] },
  },
];

const TOOL_LABEL = new Map(TOOL_DEFS.map(tool => [tool.name, tool.label]));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* --------------------------------- tools --------------------------------- */

function decodeEntities(input: string) {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeDdgLink(href: string) {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return href;
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

async function webSearch(query: string) {
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) return "لم يتم تمرير نص بحث.";
  const attempt = async (endpoint: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(endpoint, { headers: { "user-agent": UA, "accept-language": "ar,en;q=0.8" }, signal: controller.signal });
      if (!response.ok) return "";
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const html = await attempt(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`);
    const titles = Array.from(html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
    const snippets = Array.from(html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi));
    const results = titles.slice(0, 6).map((match, index) => ({
      title: stripHtml(match[2]).slice(0, 160),
      url: decodeDdgLink(match[1]),
      snippet: stripHtml(snippets[index]?.[1] ?? "").slice(0, 260),
    }));
    if (results.length) {
      return results.map((item, index) => `${index + 1}) ${item.title}\n   الرابط: ${item.url}${item.snippet ? `\n   المقتطف: ${item.snippet}` : ""}`).join("\n\n");
    }
    // Fallback: lite endpoint
    const lite = await attempt(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(cleanQuery)}`);
    const links = Array.from(lite.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
    if (links.length) {
      return links.slice(0, 6).map((match, index) => `${index + 1}) ${stripHtml(match[2]).slice(0, 160)}\n   الرابط: ${decodeDdgLink(match[1])}`).join("\n\n");
    }
    return `لم أجد نتائج واضحة عن «${cleanQuery}». جرّب صياغة أخرى أو استخدم web_fetch على رابط تعرفه.`;
  } catch (error) {
    return `تعذر إتمام البحث الآن (${error instanceof Error ? error.message : "خطأ شبكة"}).`;
  }
}

function isPrivateUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "127.0.0.1") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

async function webFetch(rawUrl: string) {
  let target: URL;
  try {
    target = new URL(String(rawUrl ?? "").trim());
  } catch {
    return "الرابط غير صالح.";
  }
  if (!/^https?:$/.test(target.protocol)) return "يسمح فقط بروابط http و https.";
  if (isPrivateUrl(target)) return "لا يسمح بفتح عناوين داخلية أو محلية.";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(target.toString(), { headers: { "user-agent": UA, "accept-language": "ar,en;q=0.8" }, redirect: "follow", signal: controller.signal });
    if (!response.ok) return `تعذر فتح الصفحة (رمز ${response.status}).`;
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const text = contentType.includes("html") ? stripHtml(raw) : raw.trim();
    return text.slice(0, 12000) || "الصفحة لا تحتوي نصًا قابلًا للقراءة.";
  } catch (error) {
    return `تعذر قراءة الصفحة (${error instanceof Error ? error.message : "خطأ شبكة"}).`;
  } finally {
    clearTimeout(timer);
  }
}

/** Small, safe recursive-descent arithmetic evaluator (no eval). */
function evaluateExpression(expression: string): number {
  const functions: Record<string, (...args: number[]) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    log: Math.log10,
    ln: Math.log,
    exp: Math.exp,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
  };
  const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
  const tokens = String(expression ?? "")
    .replace(/\s+/g, "")
    .match(/(\d+\.?\d*|\.\d+|[a-zA-Z_]\w*|[+\-*/%^(),])/g);
  if (!tokens || tokens.length === 0) throw new Error("تعبير فارغ");
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const expect = (value: string) => {
    if (next() !== value) throw new Error("تعبير غير صالح");
  };

  const parseExpr = (): number => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const right = parseFactor();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const parseFactor = (): number => {
    const base = parseUnary();
    if (peek() === "^") {
      next();
      return Math.pow(base, parseFactor());
    }
    return base;
  };
  const parseUnary = (): number => {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parsePrimary();
  };
  const parsePrimary = (): number => {
    const token = next();
    if (token === undefined) throw new Error("تعبير غير مكتمل");
    if (token === "(") {
      const value = parseExpr();
      expect(")");
      return value;
    }
    if (/^\d/.test(token) || token.startsWith(".")) return Number(token);
    const name = token.toLowerCase();
    if (name in constants && peek() !== "(") return constants[name];
    if (peek() === "(") {
      next();
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(parseExpr());
        while (peek() === ",") {
          next();
          args.push(parseExpr());
        }
      }
      expect(")");
      const fn = functions[name];
      if (!fn) throw new Error(`دالة غير معروفة: ${name}`);
      return fn(...args);
    }
    if (name in constants) return constants[name];
    throw new Error(`رمز غير معروف: ${token}`);
  };

  const result = parseExpr();
  if (index !== tokens.length) throw new Error("تعبير غير صالح");
  if (!Number.isFinite(result)) throw new Error("الناتج غير معرّف");
  return result;
}

function calculatorTool(expression: string) {
  try {
    const value = evaluateExpression(expression);
    return `${expression} = ${Number(value.toFixed(10))}`;
  } catch (error) {
    return `تعذر الحساب: ${error instanceof Error ? error.message : "تعبير غير صالح"}`;
  }
}

function datetimeTool(timezone?: string) {
  const now = new Date();
  const formatter = (locale: string, options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, options).format(now);
    } catch {
      return "—";
    }
  };
  const zone = typeof timezone === "string" && timezone.trim() ? timezone.trim() : undefined;
  const options: Intl.DateTimeFormatOptions = zone ? { timeZone: zone, dateStyle: "full", timeStyle: "long" } : { dateStyle: "full", timeStyle: "long" };
  return [
    `ISO: ${now.toISOString()}`,
    `عربي: ${formatter("ar-SA", options)}`,
    `يونكس: ${now.getTime()}`,
    `المنطقة الزمنية للخادم: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  ].join("\n");
}

async function runTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "web_search":
      return await webSearch(String(args.query ?? ""));
    case "web_fetch":
      return await webFetch(String(args.url ?? ""));
    case "calculator":
      return calculatorTool(String(args.expression ?? ""));
    case "current_datetime":
      return datetimeTool(typeof args.timezone === "string" ? args.timezone : undefined);
    default:
      return `أداة غير معروفة: ${name}`;
  }
}

function toolSummary(name: string, args: Record<string, unknown>, output: string) {
  const short = output.replace(/\s+/g, " ").slice(0, 120);
  if (name === "web_search") return `بحث: ${String(args.query ?? "")} · ${short}`;
  if (name === "web_fetch") return `قراءة: ${String(args.url ?? "")} · ${short}`;
  if (name === "calculator") return `حساب: ${String(args.expression ?? "")} = ${short}`;
  if (name === "current_datetime") return `وقت: ${short}`;
  return short;
}

/* ------------------------------ agent plumbing ---------------------------- */

type AgentMessage =
  | { role: "user" | "assistant"; content: string; attachments?: AttachmentInput[] }
  | { role: "assistant_calls"; text: string; calls: ToolCall[] }
  | { role: "tool"; id: string; name: string; content: string };

type ModelTurn = { text: string; toolCalls: ToolCall[]; usage?: TokenUsage };

function dataUri(data?: string) {
  const match = (data ?? "").match(/^data:([^;]+);base64,([\s\S]+)$/);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

async function readJson(response: Response) {
  return response.json().catch(() => ({}));
}

function joinEndpoint(base: string, path: string) {
  const clean = base.replace(/\/$/, "");
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

export function agentSupportsTools(provider: ProviderInput) {
  return provider.kind === "openai" || provider.kind === "openrouter" || provider.kind === "custom" || provider.kind === "czai" || provider.kind === "anthropic" || provider.kind === "google";
}

async function callOpenAiCompatible(provider: ProviderInput, system: string, history: AgentMessage[]): Promise<ModelTurn> {
  const base = provider.endpoint?.trim() || (provider.kind === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  const messages: unknown[] = [{ role: "system", content: system }];
  for (const message of history) {
    if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.id, content: message.content });
    } else if (message.role === "assistant_calls") {
      messages.push({
        role: "assistant",
        content: message.text || null,
        tool_calls: message.calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      });
    } else if (message.role === "user" && message.attachments?.length) {
      const parts: unknown[] = [{ type: "text", text: message.content || "حلّل المرفقات." }];
      for (const item of message.attachments) {
        if (item.text) parts.push({ type: "text", text: `الملف ${item.name}:\n${item.text}` });
        else parts.push({ type: "image_url", image_url: { url: item.data || "" } });
      }
      messages.push({ role: "user", content: parts });
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }
  const response = await fetch(joinEndpoint(base, "/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      messages,
      tools: TOOL_DEFS.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      tool_choice: "auto",
      temperature: 0.35,
    }),
  });
  const data = (await readJson(response)) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: data?.error?.message || "تعذر الاتصال بمزود الذكاء — تأكد من المفتاح واسم النموذج ورابط Endpoint" });
  const message = data.choices?.[0]?.message;
  const calls: ToolCall[] = (message?.tool_calls ?? []).map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.function?.name || "web_search",
    arguments: safeJson(call.function?.arguments),
  }));
  const usage: TokenUsage | undefined = data.usage?.prompt_tokens !== undefined || data.usage?.completion_tokens !== undefined ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 } : undefined;
  return { text: message?.content ?? "", toolCalls: calls, usage };
}

async function callAnthropic(provider: ProviderInput, system: string, history: AgentMessage[]): Promise<ModelTurn> {
  const base = provider.endpoint?.trim() || "https://api.anthropic.com/v1";
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  const push = (role: "user" | "assistant", block: unknown) => {
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as unknown[]).push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  };
  for (const message of history) {
    if (message.role === "tool") {
      push("user", { type: "tool_result", tool_use_id: message.id, content: message.content });
    } else if (message.role === "assistant_calls") {
      if (message.text) push("assistant", { type: "text", text: message.text });
      for (const call of message.calls) push("assistant", { type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    } else if (message.role === "user" && message.attachments?.length) {
      const blocks: unknown[] = [{ type: "text", text: message.content || "حلّل المرفقات." }];
      for (const item of message.attachments) {
        if (item.text) blocks.push({ type: "text", text: `الملف ${item.name}:\n${item.text}` });
        else {
          const parsed = dataUri(item.data);
          if (parsed) blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 } });
        }
      }
      for (const block of blocks) push("user", block);
    } else {
      push(message.role === "assistant" ? "assistant" : "user", { type: "text", text: message.content });
    }
  }
  const normalized = messages.map(message => (message.content as unknown[]).length === 1 && (message.content as Array<{ type?: string }>)[0]?.type === "text" ? { role: message.role, content: (message.content as Array<{ text?: string }>)[0].text ?? "" } : message);
  const response = await fetch(joinEndpoint(base, "/messages"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": provider.apiKey as string, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      system,
      messages: normalized,
      tools: TOOL_DEFS.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    }),
  });
  const data = (await readJson(response)) as { error?: { message?: string }; content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; usage?: { input_tokens?: number; output_tokens?: number } };
  if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: data?.error?.message || "تعذر الاتصال بـ Anthropic — تأكد من المفتاح واسم النموذج" });
  const blocks = data.content ?? [];
  const text = blocks.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  const calls: ToolCall[] = blocks
    .filter(block => block.type === "tool_use")
    .map((block, index) => ({ id: block.id || `tool_${index}`, name: block.name || "web_search", arguments: (block.input ?? {}) as Record<string, unknown> }));
  const usage: TokenUsage | undefined = data.usage ? { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 } : undefined;
  return { text, toolCalls: calls, usage };
}

async function callGoogle(provider: ProviderInput, system: string, history: AgentMessage[]): Promise<ModelTurn> {
  const base = provider.endpoint?.trim() || "https://generativelanguage.googleapis.com";
  const url = `${base.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey as string)}`;
  const contents: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  const push = (role: "user" | "model", part: unknown) => {
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const message of history) {
    if (message.role === "tool") {
      push("user", { functionResponse: { name: message.name, response: { result: message.content } } });
    } else if (message.role === "assistant_calls") {
      if (message.text) push("model", { text: message.text });
      for (const call of message.calls) push("model", { functionCall: { name: call.name, args: call.arguments } });
    } else if (message.role === "user" && message.attachments?.length) {
      push("user", { text: message.content || "حلّل المرفقات." });
      for (const item of message.attachments) {
        if (item.text) push("user", { text: `الملف ${item.name}:\n${item.text}` });
        else {
          const parsed = dataUri(item.data);
          if (parsed) push("user", { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
        }
      }
    } else {
      push(message.role === "assistant" ? "model" : "user", { text: message.content });
    }
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: TOOL_DEFS.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }],
    }),
  });
  const data = (await readJson(response)) as { error?: { message?: string }; candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: data?.error?.message || "تعذر الاتصال بـ Google Gemini — تأكد من المفتاح واسم النموذج" });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter(part => typeof part.text === "string").map(part => part.text ?? "").join("\n");
  const calls: ToolCall[] = parts
    .filter(part => part.functionCall)
    .map((part, index) => ({ id: `gcall_${index}_${Date.now().toString(36)}`, name: part.functionCall?.name || "web_search", arguments: part.functionCall?.args ?? {} }));
  const usage: TokenUsage | undefined = data.usageMetadata ? { input: data.usageMetadata.promptTokenCount ?? 0, output: data.usageMetadata.candidatesTokenCount ?? 0 } : undefined;
  return { text, toolCalls: calls, usage };
}

function safeJson(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function callModel(provider: ProviderInput, system: string, history: AgentMessage[]): Promise<ModelTurn> {
  if (provider.kind === "anthropic") return callAnthropic(provider, system, history);
  if (provider.kind === "google") return callGoogle(provider, system, history);
  return callOpenAiCompatible(provider, system, history);
}

function chunkText(text: string): string[] {
  const characters = Array.from(text);
  const size = 36;
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(""));
  }
  return chunks;
}

export async function* runAgent(provider: ProviderInput, messages: ChatInput[], options?: { maxSteps?: number; system?: string }): AsyncGenerator<AgentEvent> {
  if (provider.kind === "demo") {
    yield { type: "error", message: "وضع Agent يحتاج مزودًا حقيقيًا. أضف مفتاح API من الإعدادات أو اطلب من المشرف تفعيل وكيل جاهز لك." };
    yield { type: "done" };
    return;
  }
  if (!agentSupportsTools(provider)) {
    yield { type: "error", message: "هذا النوع من المزودين لا يدعم الأدوات بعد. اختر OpenAI أو Anthropic أو Google أو متوافقًا يدعم الدوال." };
    yield { type: "done" };
    return;
  }
  const history: AgentMessage[] = messages.map(message => ({ role: message.role, content: message.content, attachments: message.attachments }));
  const maxSteps = Math.max(1, Math.min(6, options?.maxSteps ?? 5));
  const system = options?.system ?? AGENT_SYSTEM;
  let finalText = "";
  let usedTool = false;
  let totalUsage: TokenUsage = { input: 0, output: 0 };
  try {
    for (let step = 0; step < maxSteps; step += 1) {
      const turn = await callModel(provider, system, history);
      if (turn.usage) {
        totalUsage = { input: totalUsage.input + (turn.usage.input ?? 0), output: totalUsage.output + (turn.usage.output ?? 0) };
      }
      if (turn.toolCalls.length) {
        usedTool = true;
        if (turn.text.trim()) {
          for (const chunk of chunkText(turn.text)) {
            yield { type: "chunk", content: chunk };
            await delay(8);
          }
        }
        history.push({ role: "assistant_calls", text: turn.text, calls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          yield { type: "status", tool: call.name, label: TOOL_LABEL.get(call.name) ?? call.name };
          let output = "";
          try {
            output = await runTool(call.name, call.arguments);
          } catch (error) {
            output = `فشل تنفيذ الأداة: ${error instanceof Error ? error.message : "خطأ غير معروف"}`;
          }
          yield { type: "tool", tool: call.name, summary: toolSummary(call.name, call.arguments, output) };
          history.push({ role: "tool", id: call.id, name: call.name, content: output.slice(0, 12000) });
        }
        continue;
      }
      finalText = turn.text;
      break;
    }
    if (!finalText.trim()) {
      finalText = usedTool
        ? "نفّذت الخطوات المطلوبة لكن لم يصل نص نهائي من النموذج. جرّب إعادة الصياغة."
        : "لم يصل رد من النموذج. تحقق من المفتاح أو جرّب مرة أخرى.";
    }
    for (const chunk of chunkText(finalText)) {
      yield { type: "chunk", content: chunk };
      await delay(12);
    }
    if (totalUsage.input || totalUsage.output) {
      yield { type: "usage", input: totalUsage.input, output: totalUsage.output };
    }
    yield { type: "done" };
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : "تعذر تشغيل الوكيل" };
    yield { type: "done" };
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const AGENT_TOOLS = TOOL_DEFS.map(tool => ({ name: tool.name, label: tool.label, description: tool.description }));
