import { TRPCError } from "@trpc/server";
import { z } from "zod";

export type AttachmentInput = { name: string; mimeType: string; data?: string; text?: string };
export type ProviderKind = "demo" | "openai" | "anthropic" | "google" | "openrouter" | "custom" | "czai";
export type ProviderInput = { kind: ProviderKind; model: string; endpoint?: string; apiKey?: string; sharedProviderId?: number; supportsAttachments?: boolean };
// Assistant messages may carry OpenRouter "reasoning_details" so a reasoning
// model can continue its chain of thought on the next turn (passed back
// unmodified, as OpenRouter requires).
export type ChatInput = { role: "user" | "assistant"; content: string; attachments?: AttachmentInput[]; reasoningDetails?: unknown[] };
export type TokenUsage = { input: number; output: number };

const attachmentSchema = z.object({ name: z.string().min(1).max(180), mimeType: z.string().max(120), data: z.string().max(15_000_000).optional(), text: z.string().max(120_000).optional() }).refine(value => Boolean(value.data || value.text), "المرفق فارغ");
export const providerSchema = z.object({ kind: z.enum(["demo", "openai", "anthropic", "google", "openrouter", "custom", "czai"]), model: z.string().min(1).max(150), endpoint: z.string().max(500).optional(), apiKey: z.string().max(500).optional(), sharedProviderId: z.number().int().positive().optional(), supportsAttachments: z.boolean().optional() });
export const messagesSchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(30000), attachments: z.array(attachmentSchema).max(4).optional(), reasoningDetails: z.array(z.unknown()).max(600).optional() })).min(1).max(100);

export function openAiLike(provider: ProviderInput) {
  return provider.kind === "openai" || provider.kind === "openrouter" || provider.kind === "custom" || provider.kind === "czai";
}

function requireKey(provider: ProviderInput) {
  if (provider.kind !== "demo" && !provider.apiKey) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد مفتاح API مضاف لهذا النموذج — أضفه من إعدادات المزود أو اطلب من المشرف تفعيله." });
}
function joinEndpoint(base: string, path: string) { const clean = base.replace(/\/$/, ""); return clean.endsWith(path) ? clean : `${clean}${path}`; }
function providerError(data: unknown, fallback: string) {
  const value = data as { error?: { message?: string; code?: number; metadata?: { raw?: string } } } | undefined;
  const raw = value?.error?.metadata?.raw || "";
  const code = value?.error?.code;
  const base = value?.error?.message || fallback;
  // Free tiers routinely hit upstream rate limits (429). Surface a clear,
  // actionable message instead of the raw "Provider returned error" blob.
  if (code === 429 || /rate[- ]?limited|rate limit|too many requests/i.test(raw)) {
    return "النموذج المجاني مزدحم حاليًا (تجاوز حد المزوّد). أعد المحاولة بعد قليل أو اختر نموذجًا آخر.";
  }
  if (/ResourceExhausted|limit reached/i.test(raw)) {
    return "المزوّد وصل حدّه المؤقت الآن. أعد المحاولة بعد قليل أو اختر نموذجًا آخر.";
  }
  return raw ? `${base} — ${raw.slice(0, 180)}` : base;
}
async function readJson(response: Response) { return response.json().catch(() => ({})); }
function dataUriParts(data: string) { const match = data.match(/^data:([^;]+);base64,([\s\S]+)$/); return match ? { mimeType: match[1], base64: match[2] } : null; }
function hasAttachments(messages: ChatInput[]) { return messages.some(message => message.attachments?.length); }
function ensureAttachmentCapability(provider: ProviderInput, messages: ChatInput[]) { if (hasAttachments(messages) && !provider.supportsAttachments) throw new TRPCError({ code: "BAD_REQUEST", message: "ميزة المرفقات غير مفعلة لهذا النموذج من لوحة التحكم" }); }

/** Wrap network-level failures with a clear, human message. */
async function fetchGuarded(input: RequestInfo | URL, init?: RequestInit, providerLabel = "مزود الذكاء") {
  try {
    return await fetch(input, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const timeout = detail.includes("abort") || detail.includes("timeout");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: timeout ? `انتهت مهلة الاتصال بـ ${providerLabel} — حاول مرة أخرى لاحقًا.` : `تعذّر الاتصال بـ ${providerLabel} — تأكد من رابط Endpoint والمفتاح ومن اتصال الإنترنت.${detail ? ` (${detail.slice(0, 160)})` : ""}`,
    });
  }
}

// Free model tiers are often briefly rate-limited upstream (429) or flaky (5xx).
// Retrying the *initial* request a couple of times is safe because nothing has
// been streamed to the client yet and it turns a transient failure into a reply.
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, providerLabel = "مزود الذكاء", attempts = 3) {
  let response = await fetchGuarded(input, init, providerLabel);
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (response.status !== 429 && response.status < 500) break;
    await response.body?.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 800 * attempt));
    response = await fetchGuarded(input, init, providerLabel);
  }
  return response;
}

function demoResponse(text: string, attachments: AttachmentInput[] = []) {
  if (attachments.length) return `استلمت ${attachments.length} مرفقًا (${attachments.map(item => item.name).join("، ")}). في الوضع التجريبي أستطيع تأكيد الاستلام فقط؛ فعّل المرفقات لنموذج رؤية حقيقي من لوحة التحكم لتحليل الصورة أو الملف.\n\nطلبك: «${text || "حلّل المرفق"}»`;
  if (/(اختبار|اسئلة|أسئلة)/i.test(text)) return `هذا اختبار تفاعلي صغير — اختر إجابة كل سؤال ثم اضغط تحقق من الإجابات.\n\nQUIZ_JSON\n${JSON.stringify({ title: "اختبار أساسيات البرمجة", description: "3 أسئلة قصيرة مع تصحيح وشرح فوري", questions: [{ question: "ما الكلمة المستخدمة لتعريف ثابت في JavaScript؟", options: ["const", "loop", "print", "style"], answer: 0, explanation: "const تعرّف قيمة لا يُعاد إسنادها." }, { question: "ما ناتج 2 + 3 × 2؟", options: ["10", "8", "12", "7"], answer: 1, explanation: "الضرب قبل الجمع، لذلك 3 × 2 = 6 ثم + 2 = 8." }, { question: "أي وسم HTML يعرّف رابطًا؟", options: ["<p>", "<img>", "<a>", "<section>"], answer: 2, explanation: "الوسم <a> مخصص للروابط." }] })}`;
  if (/(معادلة|x\^2|رياضيات)/i.test(text)) return `لنحل المعادلة خطوة بخطوة:\n\n$$x^2 + 5x + 6 = 0$$\n\nنبحث عن عددين حاصل ضربهما 6 ومجموعهما 5، وهما 2 و3. لذلك نحللها إلى:\n\n$$ (x + 2)(x + 3) = 0 $$\n\nإذن الحلول هي **x = -2** أو **x = -3**.`;
  return `وصلت فكرتك: «${text}»\n\nأنا Cz Core التجريبي داخل Ai - Cz. أستطيع مساعدتك في ترتيب الأفكار، كتابة الخطط، التلخيص، وصناعة مسودات واضحة. لإجابات حقيقية من نموذج خارجي، أضف مفتاح API من لوحة الإعدادات ثم اختر المزود من أسفل المحادثة.`;
}

export function openAiMessages(messages: ChatInput[]) { return messages.map(message => { const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: message.content || "حلّل المرفقات المرفقة." }]; for (const item of message.attachments ?? []) { if (item.text) content.push({ type: "text", text: `الملف النصي ${item.name}:\n${item.text}` }); else content.push({ type: "image_url", image_url: { url: item.data || "" } }); } const out: Record<string, unknown> = { role: message.role, content: message.attachments?.length ? content : message.content }; if (message.role === "assistant" && Array.isArray(message.reasoningDetails) && message.reasoningDetails.length) out.reasoning_details = message.reasoningDetails; return out; }); }

// Merge streaming "reasoning_details" deltas by their index so the accumulated
// array can be handed back to OpenRouter on the next turn. Text fragments for
// the same index are concatenated; every other field is kept as-is.
export function mergeReasoningDetails(acc: unknown[], incoming: unknown[] | undefined) {
  if (!Array.isArray(incoming)) return;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { index?: number; text?: string };
    const index = typeof item.index === "number" && item.index >= 0 ? item.index : acc.length;
    const existing = acc[index] as { text?: string } | undefined;
    if (existing && typeof existing.text === "string" && typeof item.text === "string") { existing.text += item.text; }
    else { acc[index] = { ...item }; }
  }
}
function anthropicMessages(messages: ChatInput[]) { return messages.map(message => { const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [{ type: "text", text: message.content || "حلّل المرفقات المرفقة." }]; for (const item of message.attachments ?? []) { if (item.text) content.push({ type: "text", text: `الملف النصي ${item.name}:\n${item.text}` }); else { const data = dataUriParts(item.data || ""); if (data) content.push({ type: "image", source: { type: "base64", media_type: data.mimeType, data: data.base64 } }); } } return { role: message.role, content: message.attachments?.length ? content : message.content }; }); }
function googleContents(messages: ChatInput[]): Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> { return messages.map(message => { const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: message.content || "حلّل المرفقات المرفقة." }]; for (const item of message.attachments ?? []) { if (item.text) parts.push({ text: `الملف النصي ${item.name}:\n${item.text}` }); else { const data = dataUriParts(item.data || ""); if (data) parts.push({ inlineData: { mimeType: data.mimeType, data: data.base64 } }); } } return { role: message.role === "assistant" ? "model" : "user", parts }; }); }

export async function callProvider(provider: ProviderInput, messages: ChatInput[]) {
  ensureAttachmentCapability(provider, messages);
  if (provider.kind === "demo") return demoResponse(messages.at(-1)?.content ?? "", messages.at(-1)?.attachments);
  requireKey(provider);
  const endpoint = provider.endpoint?.trim(); const apiKey = provider.apiKey as string; const model = provider.model;
  if (provider.kind === "anthropic") {
    const response = await fetchGuarded(joinEndpoint(endpoint || "https://api.anthropic.com/v1", "/messages"), { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1800, messages: anthropicMessages(messages) }) }, "Anthropic");
    const data = await readJson(response); if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `تعذّر الاتصال بـ Anthropic — ${providerError(data, "تأكد من صحة المفتاح والرابط")}` }); return data?.content?.map((item: { text?: string }) => item.text || "").join("\n") || "";
  }
  if (provider.kind === "google") {
    const base = endpoint || "https://generativelanguage.googleapis.com"; const url = `${base.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`; const response = await fetchGuarded(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: googleContents(messages) }) }, "Google Gemini"); const data = await readJson(response); if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `تعذّر الاتصال بـ Google Gemini — ${providerError(data, "تأكد من صحة المفتاح واسم النموذج")}` }); return data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("\n") || "";
  }
  const base = endpoint || (provider.kind === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"); const response = await (provider.kind === "openrouter" ? fetchWithRetry : fetchGuarded)(joinEndpoint(base, "/chat/completions"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: openAiMessages(messages), temperature: 0.6, ...(provider.kind === "openrouter" ? { reasoning: { enabled: true } } : {}) }) }, provider.kind === "czai" ? "CzAI" : provider.kind === "openrouter" ? "OpenRouter" : "المزود"); const data = await readJson(response); if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: providerError(data, "تعذّر الاتصال بالمزود — تأكد من صحة المفتاح واسم النموذج ورابط Endpoint") }); return data?.choices?.[0]?.message?.content || "";
}

async function* readSSE(response: Response): AsyncGenerator<string> { if (!response.body) return; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) if (line.startsWith("data:")) { const payload = line.slice(5).trim(); if (payload) yield payload; } if (done) break; } if (buffer.startsWith("data:")) yield buffer.slice(5).trim(); }
async function* streamDemo(text: string, attachments: AttachmentInput[] = []): AsyncGenerator<string> { const response = demoResponse(text, attachments); const characters = Array.from(response); for (let index = 0; index < characters.length; index += 8) { await new Promise(resolve => setTimeout(resolve, 28)); yield characters.slice(index, index + 8).join(""); } }

export type StreamHooks = { onUsage?: (usage: TokenUsage) => void; onStatus?: (status: string) => void; onReasoningDetails?: (details: unknown[]) => void };

export async function* streamProvider(provider: ProviderInput, messages: ChatInput[], hooks?: StreamHooks): AsyncGenerator<string> {
  ensureAttachmentCapability(provider, messages); if (provider.kind === "demo") { yield* streamDemo(messages.at(-1)?.content ?? "", messages.at(-1)?.attachments); return; }
  requireKey(provider); const endpoint = provider.endpoint?.trim(); const apiKey = provider.apiKey as string; const model = provider.model; let response: Response;
  if (provider.kind === "anthropic") response = await fetchGuarded(joinEndpoint(endpoint || "https://api.anthropic.com/v1", "/messages"), { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "text/event-stream" }, body: JSON.stringify({ model, max_tokens: 1800, messages: anthropicMessages(messages), stream: true }) }, "Anthropic");
  else if (provider.kind === "google") { const base = endpoint || "https://generativelanguage.googleapis.com"; const url = `${base.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`; response = await fetchGuarded(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ contents: googleContents(messages) }) }, "Google Gemini"); }
  else { const base = endpoint || (provider.kind === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"); response = await (provider.kind === "openrouter" ? fetchWithRetry : fetchGuarded)(joinEndpoint(base, "/chat/completions"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: "text/event-stream" }, body: JSON.stringify({ model, messages: openAiMessages(messages), temperature: 0.6, stream: true, stream_options: { include_usage: true }, ...(provider.kind === "openrouter" ? { reasoning: { enabled: true } } : {}) }) }, provider.kind === "czai" ? "CzAI" : provider.kind === "openrouter" ? "OpenRouter" : "المزود"); }
  if (!response.ok) { const data = await readJson(response); throw new TRPCError({ code: "BAD_REQUEST", message: providerError(data, "تعذّر بدء البث — تأكد من المفتاح واسم النموذج ورابط Endpoint") }); }
  let anthropicInput = 0; let anthropicOutput = 0; const reasoningDetails: unknown[] = [];
  for await (const event of readSSE(response)) { if (event === "[DONE]") continue; try {
    const data = JSON.parse(event) as {
      type?: string;
      delta?: { text?: string };
      choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_details?: unknown[] }; finish_reason?: string }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const chunk = data.delta?.text || data.choices?.[0]?.delta?.content || data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
    if (chunk) yield chunk;
    // Keep the reasoning trace so the model can continue from it on the next turn.
    if (data.choices?.[0]?.delta?.reasoning_details) mergeReasoningDetails(reasoningDetails, data.choices[0].delta.reasoning_details);
    // Token usage from the three provider families.
    if (data.usage?.prompt_tokens !== undefined || data.usage?.completion_tokens !== undefined) {
      hooks?.onUsage?.({ input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? (data.usage.total_tokens ?? 0) });
    }
    if (data.type === "message_start" && data.message?.usage) anthropicInput = data.message.usage.input_tokens ?? 0;
    if (data.type === "message_delta" && data.message?.usage) { anthropicOutput = data.message.usage.output_tokens ?? 0; hooks?.onUsage?.({ input: anthropicInput, output: anthropicOutput }); }
    if (data.usageMetadata) hooks?.onUsage?.({ input: data.usageMetadata.promptTokenCount ?? 0, output: data.usageMetadata.candidatesTokenCount ?? 0 });
  } catch { /* ignore keep-alive frames */ } }
  // Hand the complete reasoning trace back so it can be replayed next turn.
  if (reasoningDetails.length) hooks?.onReasoningDetails?.(reasoningDetails);
}