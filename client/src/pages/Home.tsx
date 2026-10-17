import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  FileText,
  FileKey2,
  FolderOpen,
  Download,
  Gauge,
  KeyRound,
  LockKeyhole,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  X,
  Zap,
  LoaderCircle,
  Fingerprint,
  MapPin,
  Wrench,
  Send,
  MessageCircle,
  ExternalLink,
  Ban,
  Mail,
  MailOpen,
  Headset,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { DEFAULT_PROVIDERS, SITE_CONFIG, type ProviderKind } from "@/config/site";
import RichMessage from "@/components/RichMessage";
import { getDeviceCode } from "@/lib/device";
import { t, setLangGlobal } from "@/lib/i18n";
import { formatTokenLimit, modelTokenLimit } from "@/lib/model-limits";
import { playChime, playDone, playAlert } from "@/lib/sound";

type Role = "user" | "assistant";
type ChatMessage = { id: string; role: Role; content: string; createdAt: number; model?: string; tokens?: number; reasoningDetails?: unknown[] };
type PendingAttachment = { id: string; name: string; mimeType: string; kind: "image" | "text"; data?: string; text?: string };
type Conversation = { id: string; title: string; messages: ChatMessage[]; updatedAt: number; tokens?: number; expiresAt?: number };
type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  apiKeyCipher?: string;
  isDemo?: boolean;
  lastCheck?: "ready" | "failed";
  sharedProviderId?: number;
  premium?: boolean;
  price?: number;
  description?: string;
  supportsAttachments?: boolean;
  unlocked?: boolean;
};

type DraftProvider = {
  name: string;
  kind: Exclude<ProviderKind, "demo">;
  model: string;
  endpoint: string;
  apiKey: string;
  supportsAttachments: boolean;
};

const STORAGE = {
  providers: "ai-cz.providers.v1",
  conversations: "ai-cz.conversations.v1",
  activeConversation: "ai-cz.active-conversation.v1",
  activeProvider: "ai-cz.active-provider.v1",
  cryptoSalt: "ai-cz.crypto-salt.v1",
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const formatTime = (time: number | Date | string, lang: "ar" | "en" = "ar") => new Intl.DateTimeFormat(lang === "ar" ? "ar-SA" : "en-US", { hour: "2-digit", minute: "2-digit" }).format(new Date(time));

/** Conversations auto-delete 72 hours after the last message (matches the server). */
const CONVERSATION_TTL_MS = 72 * 60 * 60 * 1000;
/** Preset Cz model names offered in the "Cz models" provider option. */
const CZ_MODEL_PRESETS = ["cz-pro", "cz-reasoner", "cz-fast", "cz-coder", "cz-vision"];

/** Human countdown until a conversation is auto-deleted. */
const formatCountdown = (expiresAt: number, nowValue: number, lang: "ar" | "en" = "ar") => {
  const remaining = expiresAt - nowValue;
  if (remaining <= 0) return lang === "ar" ? "تنتهي الآن" : "expires now";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours > 0) return lang === "ar" ? `${hours}س ${minutes}د` : `${hours}h ${minutes}m`;
  if (minutes > 0) return lang === "ar" ? `${minutes}د` : `${minutes}m`;
  return lang === "ar" ? "أقل من دقيقة" : "<1m";
};

async function getCryptoKey() {
  const encoder = new TextEncoder();
  let salt = localStorage.getItem(STORAGE.cryptoSalt);
  if (!salt) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    salt = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(STORAGE.cryptoSalt, salt);
  }
  const material = await crypto.subtle.importKey("raw", encoder.encode(salt), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("Ai-Cz-device-v1"), iterations: 120000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptSecret(secret: string) {
  if (!secret) return undefined;
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  const bytes = new Uint8Array(data);
  const payload = new Uint8Array(iv.length + bytes.length);
  payload.set(iv);
  payload.set(bytes, iv.length);
  return btoa(String.fromCharCode(...Array.from(payload)));
}

async function decryptSecret(cipher?: string) {
  if (!cipher) return "";
  try {
    const payload = Uint8Array.from(atob(cipher), char => char.charCodeAt(0));
    const key = await getCryptoKey();
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(0, 12) }, key, payload.slice(12));
    return new TextDecoder().decode(data);
  } catch {
    return "";
  }
}

async function streamChat(
  input: { provider: { kind: ProviderKind; model: string; endpoint: string; apiKey: string; sharedProviderId?: number; supportsAttachments?: boolean }; messages: { role: Role; content: string; attachments?: Array<{ name: string; mimeType: string; data?: string; text?: string }>; reasoningDetails?: unknown[] }[] },
  onChunk: (content: string) => void,
  signal: AbortSignal,
): Promise<{ content: string; usage?: { input: number; output: number }; reasoningDetails?: unknown[] }> {
  const response = await fetch("/api/ai/stream", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-code": getDeviceCode() },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || t("تعذر بدء البث", "Could not start the stream"));
  }
  if (!response.body) throw new Error(t("المتصفح لا يدعم البث المباشر", "The browser does not support live streaming"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let usage: { input: number; output: number } | undefined;
  let reasoningDetails: unknown[] | undefined;
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split(/\r?\n/).find(item => item.startsWith("data:"));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim()) as { type: string; content?: string; message?: string; input?: number; output?: number; details?: unknown[] };
      if (payload.type === "chunk" && payload.content) {
        fullContent += payload.content;
        onChunk(fullContent);
      }
      if (payload.type === "usage" && typeof payload.input === "number") usage = { input: payload.input, output: payload.output ?? 0 };
      if (payload.type === "reasoning" && Array.isArray(payload.details)) reasoningDetails = payload.details;
      if (payload.type === "error") throw new Error(payload.message || t("تعذر إكمال البث", "Could not complete the stream"));
      if (payload.type === "done") finished = true;
    }
    if (done) finished = true;
  }
  return { content: fullContent, usage, reasoningDetails };
}

type AgentStreamEvent = { type: string; content?: string; message?: string; label?: string; tool?: string; summary?: string; input?: number; output?: number };

async function streamAgent(
  input: { provider: { kind: ProviderKind; model: string; endpoint: string; apiKey: string; sharedProviderId?: number; supportsAttachments?: boolean }; messages: { role: Role; content: string; attachments?: Array<{ name: string; mimeType: string; data?: string; text?: string }> }[]; maxSteps?: number },
  handlers: { onChunk: (content: string) => void; onStatus: (text: string) => void },
  signal: AbortSignal,
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const response = await fetch("/api/ai/agent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-code": getDeviceCode() },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || t("تعذر تشغيل الوكيل", "Could not start the agent"));
  }
  if (!response.body) throw new Error(t("المتصفح لا يدعم البث المباشر", "The browser does not support live streaming"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let usage: { input: number; output: number } | undefined;
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split(/\r?\n/).find(item => item.startsWith("data:"));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim()) as AgentStreamEvent;
      if (payload.type === "chunk" && payload.content) { fullContent += payload.content; handlers.onChunk(fullContent); }
      if (payload.type === "status" && payload.label) handlers.onStatus(payload.label);
      if (payload.type === "tool" && payload.summary) handlers.onStatus(payload.summary);
      if (payload.type === "usage" && typeof payload.input === "number") usage = { input: payload.input, output: payload.output ?? 0 };
      if (payload.type === "error") throw new Error(payload.message || t("تعذر تشغيل الوكيل", "Could not start the agent"));
      if (payload.type === "done") finished = true;
    }
    if (done) finished = true;
  }
  return { content: fullContent, usage };
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|js|jsx|ts|tsx|css|html|xml|yaml|yml|py|sql|log)$/i;
async function readAttachment(file: File): Promise<PendingAttachment> {
  if (file.size > 8 * 1024 * 1024) throw new Error(t(`الملف ${file.name} أكبر من 8MB`, `File ${file.name} is larger than 8MB`));
  const isImage = file.type.startsWith("image/");
  const isText = file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name);
  if (!isImage && !isText) throw new Error(t("يسمح بالصور والملفات النصية فقط", "Only images and text files are allowed"));
  if (isText) return { id: uid(), name: file.name, mimeType: file.type || "text/plain", kind: "text", text: (await file.text()).slice(0, 120000) };
  return { id: uid(), name: file.name, mimeType: file.type, kind: "image", data: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(t("تعذر قراءة الصورة", "Could not read the image"))); reader.readAsDataURL(file); }) };
}

function useLocalState() {
  const [providers, setProviders] = useState<Provider[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE.providers);
      const parsed = stored ? (JSON.parse(stored) as Provider[]) : DEFAULT_PROVIDERS;
      // إزالة أي مزوّد تجريبي مدمج قديم من النسخ السابقة — لا ردود بلا مفتاح API.
      return parsed.filter(provider => provider.kind !== "demo");
    } catch {
      return DEFAULT_PROVIDERS;
    }
  });
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE.conversations);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => localStorage.getItem(STORAGE.activeConversation));

  useEffect(() => localStorage.setItem(STORAGE.providers, JSON.stringify(providers)), [providers]);
  useEffect(() => localStorage.setItem(STORAGE.conversations, JSON.stringify(conversations)), [conversations]);
  useEffect(() => {
    if (activeConversationId) localStorage.setItem(STORAGE.activeConversation, activeConversationId);
  }, [activeConversationId]);

  return { providers, setProviders, conversations, setConversations, activeConversationId, setActiveConversationId };
}

const PROVIDER_META: Record<Exclude<ProviderKind, "demo">, { label: string; labelEn: string; hint: string; hintEn: string; defaultModel: string; defaultEndpoint: string }> = {
  openai: { label: "OpenAI", labelEn: "OpenAI", hint: "GPT-4o / GPT-4.1", hintEn: "GPT-4o / GPT-4.1", defaultModel: "gpt-4o-mini", defaultEndpoint: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", labelEn: "Anthropic", hint: "Claude", hintEn: "Claude", defaultModel: "claude-3-5-sonnet-latest", defaultEndpoint: "https://api.anthropic.com/v1" },
  google: { label: "Google Gemini", labelEn: "Google Gemini", hint: "Gemini", hintEn: "Gemini", defaultModel: "gemini-2.0-flash", defaultEndpoint: "https://generativelanguage.googleapis.com" },
  openrouter: { label: "OpenRouter", labelEn: "OpenRouter", hint: "نماذج متعددة", hintEn: "Multiple models", defaultModel: "openai/gpt-4o-mini", defaultEndpoint: "https://openrouter.ai/api/v1" },
  custom: { label: "متوافق مخصص", labelEn: "Custom compatible", hint: "OpenAI-compatible", hintEn: "OpenAI-compatible", defaultModel: "your-model", defaultEndpoint: "" },
  czai: { label: "نماذج Cz", labelEn: "Cz models", hint: "Cz AI · يعمل مع أي واجهة متوافقة", hintEn: "Cz AI · works with any compatible endpoint", defaultModel: "cz-reasoner", defaultEndpoint: "https://api.openai.com/v1" },
};

function ContextRing({ fraction, size = 16 }: { fraction: number; size?: number }) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = clamped >= 0.999;
  return (
    <svg className={`ctx-ring ${full ? "full" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ctx-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <circle className="ctx-ring-fill" cx={size / 2} cy={size / 2} r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clamped)} />
    </svg>
  );
}

// Shows the live context usage as a row of small rings: one ring per context
// window. Each ring fills as tokens are spent, and once a window is full the next
// ring starts filling beside it while the running totals stay intact.
function ContextMeter({ used, model, lang }: { used: number; model?: string | null; lang: "ar" | "en" }) {
  const limit = modelTokenLimit(model);
  const locale = lang === "ar" ? "ar-SA" : "en-US";
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  if (!limit || limit <= 0) {
    if (!used) return null;
    return <span className="token-chip" title={L("إجمالي التوكنز المستهلكة في هذه المحادثة", "Total tokens used in this conversation")}><Gauge size={13} /><b>{used.toLocaleString(locale)}</b><small>{L("توكن", "tokens")}</small></span>;
  }
  const windows = Math.max(1, Math.ceil(used / limit));
  const shown = Math.min(windows, 6);
  const hidden = windows - shown;
  return (
    <span className="ctx-meter" title={L(`استُهلك ${used.toLocaleString(locale)} توكن من أصل ${limit.toLocaleString(locale)} في نافذة السياق`, `Used ${used.toLocaleString(locale)} of ${limit.toLocaleString(locale)} tokens in the context window`)}>
      <span className="ctx-rings">
        {Array.from({ length: shown }, (_, index) => <ContextRing key={index} fraction={(used - index * limit) / limit} />)}
        {hidden > 0 ? <span className="ctx-more">+{hidden}</span> : null}
      </span>
      <span className="ctx-meter-copy"><b>{used.toLocaleString(locale)}</b><small>{L("من", "of")} {formatTokenLimit(model)}</small></span>
    </span>
  );
}

function SubscriptionGate({ siteName, telegramUsername, lang }: { siteName: string; telegramUsername: string; lang: "ar" | "en" }) {
  const username = telegramUsername.replace(/^@/, "");
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  return <div className="subscription-gate" dir={lang === "ar" ? "rtl" : "ltr"}><div className="subscription-gate-orb"><span>Cz</span><i /><i /></div><span className="eyebrow"><LockKeyhole size={14} /> {L("الوصول محمي بالاشتراك", "Access protected by subscription")}</span><h1>{L("اشترك للوصول إلى", "Subscribe to access")} <em>{siteName}</em></h1><p>{L("للحصول على تجربة الذكاء الكاملة، تواصل معنا عبر تيليجرام وسيتم تفعيل وصولك.", "For the full AI experience, contact us on Telegram and your access will be activated.")}</p><a className="telegram-cta" href={`https://t.me/${username}`} target="_blank" rel="noreferrer">{L("التواصل للاشتراك", "Contact to subscribe")} <span>↗</span></a><small>{L("سيتم تحويلك إلى", "You will be redirected to")} @{username}</small></div>;
}

export default function Home() {
  const { providers, setProviders, conversations, setConversations, activeConversationId, setActiveConversationId } = useLocalState();
  const siteConfig = trpc.site.getConfig.useQuery();
  const quota = trpc.site.quota.useQuery(undefined, { refetchInterval: 30000 });
  const [isLight, setIsLight] = useState(() => {
    try { return localStorage.getItem("ai-cz.theme.v1") === "light"; } catch { return false; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"providers" | "identity">("providers");
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [activeProviderId, setActiveProviderId] = useState(() => {
    try { return localStorage.getItem(STORAGE.activeProvider) ?? ""; } catch { return ""; }
  });
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [activeAttachmentCount, setActiveAttachmentCount] = useState(0);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [draft, setDraft] = useState<DraftProvider>({ name: "", kind: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1", apiKey: "", supportsAttachments: false });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const verifyMutation = trpc.ai.verify.useMutation();
  const deviceCode = useMemo(() => getDeviceCode(), []);
  const [mode, setMode] = useState<"chat" | "agent">("chat");
  const [agentActivity, setAgentActivity] = useState("");
  const [geoModalOpen, setGeoModalOpen] = useState(false);
  const [geoGranted, setGeoGranted] = useState(false);
  const geoWatchRef = useRef<number | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<Provider | null>(null);
  const [telegramCopied, setTelegramCopied] = useState(false);
  // Mail inbox ("من المشرف") and the live support chat widget.
  const [mailOpen, setMailOpen] = useState(false);
  const [openMessageId, setOpenMessageId] = useState<number | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportDraft, setSupportDraft] = useState("");
  const [lang, setLang] = useState<"ar" | "en">(() => {
    try { return localStorage.getItem("ai-cz.lang.v1") === "en" ? "en" : "ar"; } catch { return "ar"; }
  });
  // Inline translator: keeps the Arabic source string next to its English twin.
  const tr = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const fmtNum = (value: number) => value.toLocaleString(lang === "ar" ? "ar-SA" : "en-US");
  const [agentEnabled, setAgentEnabled] = useState(false);
  const deviceSync = trpc.device.sync.useMutation();
  const setLocationMutation = trpc.device.setLocation.useMutation();
  const serverChats = trpc.chat.list.useQuery();
  const saveChat = trpc.chat.save.useMutation();
  const deleteChat = trpc.chat.delete.useMutation();
  const reportProviders = trpc.device.reportProviders.useMutation();
  const inbox = trpc.mail.list.useQuery({ code: deviceCode }, { enabled: Boolean(deviceCode), refetchInterval: 5000 });
  const markMailRead = trpc.mail.markRead.useMutation({ onSuccess: () => inbox.refetch() });
  const supportSummary = trpc.support.summary.useQuery({ code: deviceCode }, { enabled: Boolean(deviceCode), refetchInterval: 6000 });
  const supportThread = trpc.support.thread.useQuery({ code: deviceCode }, { enabled: Boolean(deviceCode) && supportOpen, refetchInterval: supportOpen ? 4000 : false });
  const sendSupport = trpc.support.send.useMutation({ onSuccess: () => { setSupportDraft(""); supportThread.refetch(); supportSummary.refetch(); }, onError: error => toast.error(error.message) });
  const mailList = inbox.data?.messages ?? [];
  const mailUnread = inbox.data?.unread ?? 0;
  const openMessage = (id: number) => { setOpenMessageId(prev => (prev === id ? null : id)); if (!mailList.find(message => message.id === id)?.read) markMailRead.mutate({ id, code: deviceCode }); };

  // "مباشر لايف": chime on the visitor's device the moment new admin mail arrives.
  const prevMailUnread = useRef<number | null>(null);
  useEffect(() => {
    if (prevMailUnread.current !== null && mailUnread > prevMailUnread.current) playChime();
    prevMailUnread.current = mailUnread;
  }, [mailUnread]);

  // Same for a new support reply from the admin.
  const supportUnread = supportSummary.data?.unread ?? 0;
  const prevSupportUnread = useRef<number | null>(null);
  useEffect(() => {
    if (prevSupportUnread.current !== null && supportUnread > prevSupportUnread.current) playChime();
    prevSupportUnread.current = supportUnread;
  }, [supportUnread]);

  // A soft alert when the purchase dialog opens (a decision is needed).
  useEffect(() => {
    if (purchaseTarget) playAlert();
  }, [purchaseTarget]);
  const hydratedRef = useRef(false);
  const supportScrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Set when the admin bans this device; shows a full-screen kick-out.
  const [deviceBan, setDeviceBan] = useState<{ reason: string | null } | null>(null);

  /** Flags a ban locally when a server error reveals one, returning true when banned. */
  const flagIfBanned = (message?: string) => {
    if (message && message.includes("تم حظر هذا الجهاز")) {
      setDeviceBan({ reason: message });
      return true;
    }
    return false;
  };

  // Keep the support chat pinned to the newest message while it is open.
  useEffect(() => {
    if (supportOpen && supportScrollRef.current) supportScrollRef.current.scrollTop = supportScrollRef.current.scrollHeight;
  }, [supportOpen, supportThread.data?.messages.length]);

  // Tick the 72-hour countdown chips without re-rendering too often.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Sync the browser chrome (mobile address bar + form controls) with the chosen theme.
  useEffect(() => {
    document.documentElement.style.colorScheme = isLight ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isLight ? "#f6f9fd" : "#080b12");
    try { localStorage.setItem("ai-cz.theme.v1", isLight ? "light" : "dark"); } catch { /* ignore */ }
  }, [isLight]);

  // Persist the chosen UI language (Arabic default, English optional).
  useEffect(() => {
    try { localStorage.setItem("ai-cz.lang.v1", lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
    setLangGlobal(lang);
  }, [lang]);

  useEffect(() => {
    const sync = () => deviceSync.mutate({ code: deviceCode }, {
      onSuccess: data => {
        setAgentEnabled(Boolean(data?.agentActive));
        setDeviceBan(data?.banned ? { reason: data?.banReason ?? null } : null);
      },
      onError: error => { if (!flagIfBanned(error.message)) toast.error(error.message || tr("تعذّر الاتصال بالخادم", "Could not reach the server")); },
    });
    sync();
    // Re-check every 20 seconds so an admin ban kicks the visitor out mid-session.
    const timer = window.setInterval(sync, 20000);
    return () => window.clearInterval(timer);
  }, [deviceCode]);

  // Geolocation gate: live location, re-checked on every load and when the tab
  // regains focus, until the visitor actually grants permission. It hides the
  // moment access is granted and comes back if they revoke it — no randomness.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let permission: PermissionStatus | null = null;

    const evaluate = (state: PermissionState | "unsupported") => {
      if (state === "granted") {
        setGeoGranted(true);
        setGeoModalOpen(false);
        startGeoWatch();
      } else {
        // "prompt", "denied" (revoked) or "unsupported" → keep asking.
        setGeoGranted(false);
        setGeoModalOpen(true);
      }
    };
    const recheck = () => evaluate(permission ? permission.state : "unsupported");
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheck();
    };

    void (async () => {
      try {
        permission = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        permission.addEventListener("change", recheck);
        evaluate(permission.state);
      } catch {
        // No Permissions API (e.g. Safari): show the gate, then probe silently.
        setGeoGranted(false);
        setGeoModalOpen(true);
        probeGeo();
      }
    })();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      permission?.removeEventListener("change", recheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceCode]);

  useEffect(() => () => { if (geoWatchRef.current != null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatchRef.current); }, []);

  // Silent restore: pull this device's saved conversations (stored server-side by IP).
  useEffect(() => {
    if (hydratedRef.current) return;
    const remote = serverChats.data;
    if (!Array.isArray(remote)) return;
    hydratedRef.current = true;
    if (!remote.length) return;
    setConversations(prev => {
      const map = new Map(prev.map(item => [item.id, item]));
      for (const item of remote) {
        const local = map.get(item.id);
        if (!local || item.updatedAt >= local.updatedAt) {
          map.set(item.id, { id: item.id, title: item.title, messages: item.messages as ChatMessage[], updatedAt: item.updatedAt, tokens: item.tokens, expiresAt: item.expiresAt });
        }
      }
      return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, [serverChats.data, setConversations]);

  /** Starts the live position stream once permission is granted. */
  const startGeoWatch = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    if (geoWatchRef.current != null) return;
    geoWatchRef.current = navigator.geolocation.watchPosition(
      position => {
        setGeoGranted(true);
        setGeoModalOpen(false);
        setLocationMutation.mutate({ code: deviceCode, latitude: position.coords.latitude, longitude: position.coords.longitude });
      },
      error => {
        // PERMISSION_DENIED → the visitor revoked access, so nag again.
        if (error.code === error.PERMISSION_DENIED) {
          setGeoGranted(false);
          setGeoModalOpen(true);
          if (geoWatchRef.current != null) { navigator.geolocation.clearWatch(geoWatchRef.current); geoWatchRef.current = null; }
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 },
    );
  };

  /** Single silent probe used when the Permissions API is unavailable. */
  const probeGeo = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      position => {
        setGeoGranted(true);
        setGeoModalOpen(false);
        setLocationMutation.mutate({ code: deviceCode, latitude: position.coords.latitude, longitude: position.coords.longitude });
        startGeoWatch();
      },
      () => undefined,
      { enableHighAccuracy: false, timeout: 9000 },
    );
  };

  const allowGeo = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoModalOpen(false);
      return;
    }
    // The click is the user gesture that lets the browser show its prompt.
    navigator.geolocation.getCurrentPosition(
      position => {
        setGeoGranted(true);
        setGeoModalOpen(false);
        setLocationMutation.mutate({ code: deviceCode, latitude: position.coords.latitude, longitude: position.coords.longitude });
        startGeoWatch();
      },
      error => {
        if (error.code === error.PERMISSION_DENIED) toast.error(tr("تم رفض إذن الموقع. فعّل الوصول للموقع من إعدادات المتصفح.", "Location permission was denied. Enable location access in your browser settings."));
      },
      { enableHighAccuracy: true, timeout: 20000 },
    );
  };

  const activeConversation = useMemo(() => conversations.find(item => item.id === activeConversationId), [conversations, activeConversationId]);
  const activeProvider = providers.find(item => item.id === activeProviderId) ?? providers.find(item => !(item.premium && !item.unlocked)) ?? providers[0];
  const filteredConversations = conversations.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const pickerProviders = useMemo(() => [...providers].sort((a, b) => Number(Boolean(a.premium && !a.unlocked)) - Number(Boolean(b.premium && !b.unlocked))), [providers]);

  useEffect(() => {
    const sharedProviders = (siteConfig.data?.providers ?? []).map(provider => ({ id: provider.id, name: provider.name, kind: provider.kind as ProviderKind, model: provider.model, endpoint: provider.endpoint, isDemo: false, sharedProviderId: Number(provider.id.replace("shared-", "")), premium: provider.premium, price: provider.price, description: provider.description, supportsAttachments: provider.supportsAttachments, unlocked: provider.unlocked, lastCheck: "ready" as const }));
    if (!sharedProviders.length) return;
    setProviders(prev => [...prev.filter(provider => !provider.sharedProviderId), ...sharedProviders]);
  }, [siteConfig.data?.providers, setProviders]);

  // Keep the admin aware of the models each visitor adds for themselves (metadata only, never the key).
  useEffect(() => {
    if (!deviceCode) return;
    const reportable = providers.filter(provider => !provider.sharedProviderId).map(provider => ({ name: provider.name, kind: provider.kind, model: provider.model, endpoint: provider.endpoint || undefined, supportsAttachments: Boolean(provider.supportsAttachments) }));
    reportProviders.mutate({ code: deviceCode, providers: reportable });
  }, [providers, deviceCode]);

  // Persist the active model so refreshing the page keeps the same choice ("ثابت").
  useEffect(() => {
    try { localStorage.setItem(STORAGE.activeProvider, activeProviderId); } catch { /* ignore */ }
  }, [activeProviderId]);

  useEffect(() => {
    if (!providers.some(item => item.id === activeProviderId && !(item.premium && !item.unlocked))) setActiveProviderId((providers.find(item => !(item.premium && !item.unlocked)) ?? providers[0])?.id ?? "");
  }, [providers, activeProviderId]);

  if (siteConfig.data?.subscriptionRequired) return <SubscriptionGate siteName={siteConfig.data.siteName} telegramUsername={siteConfig.data.telegramUsername} lang={lang} />;

  const persistConversation = (conversation: Conversation) => {
    const stamp = { ...conversation, expiresAt: Math.max(conversation.expiresAt ?? 0, Date.now() + CONVERSATION_TTL_MS) };
    setConversations(prev => {
      const next = prev.some(item => item.id === stamp.id) ? prev.map(item => item.id === stamp.id ? stamp : item) : [stamp, ...prev];
      return next.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setComposer("");
    setPendingAttachments([]);
    setMobileSidebar(false);
    composerRef.current?.focus();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const incoming = await Promise.all(Array.from(files).slice(0, 4).map(readAttachment));
      setPendingAttachments(prev => [...prev, ...incoming].slice(0, 4));
      toast.success(tr(`تمت إضافة ${incoming.length} مرفق للتحليل`, `Added ${incoming.length} attachment(s) for analysis`));
    } catch (error) { toast.error(error instanceof Error ? error.message : "تعذر قراءة المرفق"); }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDeleteConversation = (id: string) => {
    setConversations(prev => prev.filter(item => item.id !== id));
    if (activeConversationId === id) setActiveConversationId(null);
    deleteChat.mutate({ conversationId: id });
    toast.success(tr("تم حذف المحادثة", "Conversation deleted"));
  };

  const handleSend = async () => {
    const content = composer.trim();
    if ((!content && !pendingAttachments.length) || isSending) return;
    if (!activeProvider) {
      toast.error(tr("مافي API — أضف مفتاح API خاصًا بك من الإعدادات لتشغيل المحادثة.", "No API — add your own API key from settings to start the conversation."));
      setSettingsOpen(true);
      setSettingsTab("providers");
      return;
    }
    if (activeProvider.premium && !activeProvider.unlocked) {
      setPurchaseTarget(activeProvider);
      return;
    }
    if (mode === "agent" && !agentEnabled) { toast.error(tr("ميزة Agent غير مفعّلة لهذا الجهاز. اطلب من المشرف تفعيلها.", "The Agent feature is not enabled for this device. Ask the admin to enable it.")); return; }
    if (pendingAttachments.length && !activeProvider.supportsAttachments) { toast.error(tr("المرفقات غير مفعلة لهذا النموذج. فعّلها من إعدادات النموذج أو اختر نموذجًا داعمًا.", "Attachments are off for this model. Enable them in the model settings or pick a model that supports them.")); return; }
    const requestAttachments = pendingAttachments;
    const displayContent = content || "حلّل المرفقات المرفقة";
    setComposer("");
    setPendingAttachments([]);
    setActiveAttachmentCount(requestAttachments.length);
    setIsSending(true);
    setAgentActivity("");
    const conversationId = activeConversationId ?? uid();
    if (!activeConversationId) setActiveConversationId(conversationId);
    const userMessage: ChatMessage = { id: uid(), role: "user", content: displayContent, createdAt: Date.now() };
    const previousMessages = activeConversation?.messages ?? [];
    const nextMessages = [...previousMessages, userMessage];
    const nextConversation: Conversation = {
      id: conversationId,
      title: previousMessages.length ? activeConversation?.title ?? displayContent.slice(0, 32) : displayContent.slice(0, 32),
      messages: nextMessages,
      updatedAt: Date.now(),
      tokens: activeConversation?.tokens ?? 0,
    };
    persistConversation(nextConversation);
    saveChat.mutate({ conversationId, title: nextConversation.title, mode, messages: nextMessages, tokens: nextConversation.tokens });
    const assistantId = uid();
    const assistantCreatedAt = Date.now();
    const modelLabel = `${activeProvider.name} · ${activeProvider.model}`;
    const streamingConversation: Conversation = {
      ...nextConversation,
      messages: [...nextMessages, { id: assistantId, role: "assistant", content: "", createdAt: assistantCreatedAt, model: modelLabel }],
    };
    persistConversation(streamingConversation);
    const convTokens = (msgs: ChatMessage[]) => msgs.reduce((sum, message) => sum + (message.tokens ?? 0), 0);
    let finalMessages = streamingConversation.messages;
    let finishedOk = false;
    const buildFinal = (text: string, usage?: { input: number; output: number }, reasoningDetails?: unknown[]): ChatMessage[] => [
      ...nextMessages,
      {
        id: assistantId,
        role: "assistant" as const,
        content: text,
        createdAt: assistantCreatedAt,
        model: modelLabel,
        tokens: usage ? Math.max(0, (usage.input ?? 0) + (usage.output ?? 0)) : undefined,
        reasoningDetails: reasoningDetails?.length ? reasoningDetails : undefined,
      },
    ];
    const syncStream = (msgs: ChatMessage[]) => {
      finalMessages = msgs;
      persistConversation({ ...streamingConversation, messages: msgs, updatedAt: Date.now(), tokens: convTokens(msgs) });
    };
    try {
      const apiKey = activeProvider.sharedProviderId ? "" : await decryptSecret(activeProvider.apiKeyCipher);
      const providerPayload = {
        kind: activeProvider.kind,
        model: activeProvider.model,
        endpoint: activeProvider.endpoint,
        apiKey,
        sharedProviderId: activeProvider.sharedProviderId,
        supportsAttachments: activeProvider.supportsAttachments,
      };
      const historyMessages = [...nextMessages.slice(0, -1).map(message => ({ role: message.role, content: message.content, ...(message.role === "assistant" && message.reasoningDetails?.length ? { reasoningDetails: message.reasoningDetails } : {}) })), { role: "user" as const, content: displayContent, attachments: requestAttachments.map(({ name, mimeType, data, text }) => ({ name, mimeType, data, text })) }];
      if (mode === "agent") {
        const agentResult = await streamAgent({ provider: providerPayload, messages: historyMessages, maxSteps: 5 }, {
          onChunk: text => syncStream(buildFinal(text)),
          onStatus: text => setAgentActivity(text),
        }, new AbortController().signal);
        syncStream(buildFinal(agentResult.content, agentResult.usage));
        finishedOk = true;
      } else {
        const chatResult = await streamChat({ provider: providerPayload, messages: historyMessages }, text => {
          syncStream(buildFinal(text));
        }, new AbortController().signal);
        syncStream(buildFinal(chatResult.content, chatResult.usage, chatResult.reasoningDetails));
        finishedOk = true;
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : tr("تعذر إكمال الطلب", "Could not complete the request");
        if (flagIfBanned(message)) {
          setIsSending(false);
          return;
        }
        toast.error(message);
        syncStream(buildFinal(`⚠️ ${message}`));
      }
    } finally {
      setIsSending(false);
      setActiveAttachmentCount(0);
      setAgentActivity("");
      quota.refetch();
      saveChat.mutate({ conversationId, title: nextConversation.title, mode, messages: finalMessages, tokens: convTokens(finalMessages) });
      setTimeout(() => composerRef.current?.focus(), 50);
      // Chime on the visitor's device when the answer is ready ("عند الانتهاء").
      if (finishedOk) playDone();
    }
  };

  const downloadPdf = async (message: ChatMessage) => {
    try {
      const response = await fetch("/api/ai/pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: tr("إجابة Ai - Cz", "Ai - Cz answer"), content: message.content }) });
      if (!response.ok) throw new Error(tr("تعذر إنشاء ملف PDF", "Could not create the PDF file"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "ai-cz-answer.pdf";
      link.click();
      URL.revokeObjectURL(url);
      toast.success(tr("تم تجهيز ملف PDF للتحميل", "The PDF is ready to download"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("تعذر تحميل PDF", "Could not download the PDF"));
    }
  };

  const downloadConversationPdf = async () => {
    if (!activeConversation?.messages.length) {
      toast.error(tr("لا توجد رسائل لتصديرها بعد", "No messages to export yet"));
      return;
    }
    try {
      const response = await fetch("/api/ai/pdf/conversation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: activeConversation.title, mode, tokens: activeConversation.tokens ?? 0, messages: activeConversation.messages }),
      });
      if (!response.ok) throw new Error(tr("تعذر إنشاء ملف PDF", "Could not create the PDF file"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "ai-cz-conversation.pdf";
      link.click();
      URL.revokeObjectURL(url);
      toast.success(tr("تم تجهيز PDF للمحادثة كاملة — تتضمن أسماء النماذج والتوكنز", "Full-conversation PDF ready — includes model names and tokens"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("تعذر تحميل PDF", "Could not download the PDF"));
    }
  };

  const handleVerify = async (provider: Provider) => {
    const apiKey = await decryptSecret(provider.apiKeyCipher);
    if (!provider.sharedProviderId && provider.kind !== "demo" && !apiKey) {
      toast.error(tr("أضف مفتاح API أولاً", "Add an API key first"));
      return;
    }
    try {
      await verifyMutation.mutateAsync({ provider: { kind: provider.kind, model: provider.model, endpoint: provider.endpoint, apiKey, sharedProviderId: provider.sharedProviderId } });
      setProviders(prev => prev.map(item => item.id === provider.id ? { ...item, lastCheck: "ready" } : item));
      toast.success(tr(`${provider.name} جاهز للاستخدام`, `${provider.name} is ready to use`));
    } catch (error) {
      setProviders(prev => prev.map(item => item.id === provider.id ? { ...item, lastCheck: "failed" } : item));
      toast.error(error instanceof Error ? error.message : tr("فشل التحقق من المزود", "Provider verification failed"));
    }
  };

  const handleAddProvider = async () => {
    if (!draft.name.trim()) {
      toast.error("اكتب اسمًا واضحًا للمزود");
      return;
    }
    if (!draft.apiKey.trim()) {
      toast.error(tr("أضف مفتاح API للتحقق من المزود", "Add an API key to verify the provider"));
      return;
    }
    const provider: Provider = {
      id: uid(),
      name: draft.name.trim(),
      kind: draft.kind,
      model: draft.model.trim() || PROVIDER_META[draft.kind].defaultModel,
      endpoint: draft.endpoint.trim() || PROVIDER_META[draft.kind].defaultEndpoint,
      apiKeyCipher: await encryptSecret(draft.apiKey.trim()),
      supportsAttachments: draft.supportsAttachments,
    };
    setProviders(prev => [...prev, provider]);
    setActiveProviderId(provider.id);
    setDraft({ name: "", kind: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1", apiKey: "", supportsAttachments: false });
    toast.success(tr("تمت إضافة المزود محليًا — اضغط تحقق للتأكد من المفتاح", "Provider added locally — press Check to verify the key"));
  };

  const handleDraftKindChange = (kind: Exclude<ProviderKind, "demo">) => {
    const meta = PROVIDER_META[kind];
    setDraft(prev => ({ ...prev, kind, model: kind === "czai" ? CZ_MODEL_PRESETS[1] : meta.defaultModel, endpoint: meta.defaultEndpoint }));
  };

  const handleCzModelChange = (value: string) => {
    setDraft(prev => ({ ...prev, model: value === "__custom" ? "" : value }));
  };

  const removeProvider = (provider: Provider) => {
    if (provider.isDemo) return;
    const remaining = providers.filter(item => item.id !== provider.id);
    setProviders(remaining);
    if (activeProviderId === provider.id) setActiveProviderId(remaining[0]?.id ?? "");
    toast.success(tr("تم حذف المزود من هذا الجهاز", "Provider removed from this device"));
  };

  const copyMessage = async (content: string) => {
    await navigator.clipboard.writeText(content);
    toast.success(tr("تم نسخ الرد", "Reply copied"));
  };

  return (
    <div className={`app-shell ${isLight ? "light-mode" : ""}`} dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      {deviceBan && (
        <div className="ban-overlay">
          <div className="ban-card glass">
            <div className="ban-icon"><Ban size={30} /></div>
            <h2>{tr("تم حظر هذا الجهاز", "This device has been banned")}</h2>
            <p>{deviceBan.reason || tr("تم إيقاف وصول هذا الجهاز إلى الموقع.", "Access from this device has been stopped.")}</p>
            <p className="ban-contact">{tr("تواصل مع المشرف", "Contact the admin")}</p>
            <a className="ban-telegram" href={`https://t.me/${(siteConfig.data?.telegramUsername ?? "qe_3z").replace(/^@/, "")}`} target="_blank" rel="noreferrer">@{(siteConfig.data?.telegramUsername ?? "qe_3z").replace(/^@/, "")}</a>
            <small>{tr("لن يعمل الموقع على هذا الجهاز حتى يتم رفع الحظر.", "The site will not work on this device until the ban is lifted.")}</small>
          </div>
        </div>
      )}
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar glass">
        <div className="brand-block">
          <button className="mobile-menu icon-button" onClick={() => setMobileSidebar(!mobileSidebar)} aria-label={tr("القائمة", "Menu")}><Menu size={19} /></button>
          <div className="brand-mark"><span>Cz</span><i /></div>
          <div><strong>{SITE_CONFIG.name}</strong><small>{tr("مختبر الذكاء الخاص بك", "Your private intelligence lab")}</small></div>
        </div>
        <div className="topbar-actions">
          <button className="device-chip" onClick={() => { navigator.clipboard.writeText(deviceCode).then(() => toast.success(tr("تم نسخ كود الجهاز", "Device code copied"))).catch(() => undefined); }} title={tr("كود هذا الجهاز — ثابت ولا يتغير", "This device's code — fixed and permanent")}><Fingerprint size={14} /><span>{deviceCode}</span></button>
          <div className="security-chip"><ShieldCheck size={15} /><span>{tr("حماية محلية", "Local protection")}</span></div>
          <button className={`icon-button mail-button ${mailOpen ? "open" : ""}`} onClick={() => setMailOpen(!mailOpen)} aria-label={tr("البريد", "Mail")} title={tr("البريد من المشرف", "Mail from the admin")}><Mail size={18} />{mailUnread > 0 && <span className="mail-badge">{mailUnread > 9 ? "9+" : fmtNum(mailUnread)}</span>}</button>
          <button className="icon-button" onClick={() => setIsLight(!isLight)} aria-label={tr("تبديل المظهر", "Toggle theme")}><span className="theme-dot" /></button>
          <button className="icon-button" onClick={() => { setSettingsOpen(!settingsOpen); setSettingsTab("providers"); }} aria-label={tr("الإعدادات", "Settings")}><Settings2 size={18} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar glass ${mobileSidebar ? "sidebar-open" : ""}`}>
          <div className="sidebar-top">
            <button className="new-chat-btn" onClick={handleNewChat}><MessageSquarePlus size={17} /><span>{tr("محادثة جديدة", "New chat")}</span><kbd>⌘ K</kbd></button>
            <label className="search-box"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={tr("ابحث في محادثاتك", "Search your chats")} /><span>/</span></label>
          </div>
          <div className="conversation-heading"><span>{tr("المحادثات الأخيرة", "Recent chats")}</span><button className="tiny-button"><MoreHorizontal size={16} /></button></div>
          <div className="conversation-list">
            {filteredConversations.length === 0 ? (
              <div className="empty-sidebar"><FolderOpen size={23} /><span>{tr("لا توجد محادثات محفوظة", "No saved chats yet")}</span><small>{tr("ابدأ فكرة جديدة وستظهر هنا", "Start a new idea and it appears here")}</small></div>
            ) : filteredConversations.map(item => (
              <div className={`conversation-row ${item.id === activeConversationId ? "selected" : ""}`} key={item.id}>
                <button onClick={() => { setActiveConversationId(item.id); setMobileSidebar(false); }}><MessageSquarePlus size={15} /><span>{item.title || tr("محادثة بلا عنوان", "Untitled chat")}{item.expiresAt ? <small className="conv-expiry"><Timer size={10} />{formatCountdown(item.expiresAt, now, lang)}</small> : null}</span></button>
                <button className="row-delete" onClick={() => handleDeleteConversation(item.id)} aria-label={tr("حذف", "Delete")}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <div className="local-card"><div className="local-icon"><LockKeyhole size={17} /></div><div><b>{tr("بياناتك ملكك", "Your data is yours")}</b><span>{tr("المحادثات محفوظة على جهازك فقط", "Chats are stored on your device only")}</span></div><CheckCircle2 size={16} className="green-icon" /></div>
            <div className="sidebar-meta"><span>Ai - Cz v1.0</span><button onClick={() => { setSettingsOpen(true); setSettingsTab("identity"); }}><CircleHelp size={14} /> {tr("كيف يعمل؟", "How does it work?")}</button></div>
          </div>
        </aside>

        <main className="chat-stage">
          <div className="chat-header">
            <div className="chat-context"><div className="status-orb"><Bot size={17} /></div><div><b>{activeConversation?.title || tr("مساحتك الذكية", "Your smart space")}</b><span><i className={`online-dot ${providers.length ? "" : "off"}`} /> {providers.length ? tr("متصل — جاهز للتفكير", "Connected — ready to think") : tr("غير مهيأ — أضف مفتاح API", "Not ready — add an API key")}</span></div></div>
            <div className="chat-header-actions"><ContextMeter used={activeConversation?.tokens ?? 0} model={activeProvider?.model} lang={lang} />{activeConversation?.expiresAt ? <span className="expiry-chip" title={tr("تُحذف المحادثة تلقائيًا بعد 72 ساعة", "The conversation auto-deletes after 72 hours")}><Timer size={13} /><span>{formatCountdown(activeConversation.expiresAt, now, lang)}</span></span> : null}{activeConversation ? <button className="pdf-button" onClick={downloadConversationPdf} title={tr("تحميل المحادثة كاملة PDF", "Download the full conversation as PDF")}><Download size={14} /> PDF</button> : null}<button className="lang-button" onClick={() => setLang(lang === "ar" ? "en" : "ar")} title={tr("تحويل الموقع إلى الإنجليزية", "Switch the site to Arabic")} aria-label={tr("تغيير اللغة", "Change language")}>{lang === "ar" ? "EN" : "ع"}</button><button className={`model-pill ${modelPickerOpen ? "open" : ""}`} onClick={() => setModelPickerOpen(!modelPickerOpen)} title={tr("تبديل النموذج", "Switch model")}><span className="model-glow" />{activeProvider?.name ?? tr("أضف مفتاح API", "Add an API key")}<ChevronDown size={14} /></button><button className="icon-button subtle" onClick={() => setSettingsOpen(true)}><PanelRight size={17} /></button></div>
          </div>
          <div className="messages-viewport">
            {(!activeConversation || activeConversation.messages.length === 0) ? (
              <div className="welcome-state">
                <div className="hero-orbit"><div className="hero-logo">Cz<span>✦</span></div><div className="orbit orbit-a" /><div className="orbit orbit-b" /></div>
                <p className="eyebrow"><Sparkles size={14} /> {tr("مساحة تفكير بلا حدود", "Unlimited thinking space")}</p>
                <h1>{tr("مرحبًا بك في", "Welcome to")} <em>Ai - Cz</em></h1>
                <p className="welcome-copy">{tr("اكتب فكرة، اسأل سؤالًا، أو ابدأ من إحدى البدايات السريعة.", "Write an idea, ask a question, or start from a quick prompt.")}<br />{tr("أنا هنا لأرتّب الفوضى وأحوّلها إلى شيء واضح.", "I'm here to tame the chaos and turn it into something clear.")}</p>
                <div className="prompt-grid">
                  {[tr("لخّص لي هذا اليوم في 3 نقاط", "Summarize my day in 3 points"), tr("اكتب خطة لمشروع ذكي", "Write a plan for a smart project"), tr("اشرح فكرة معقدة ببساطة", "Explain a complex idea simply"), tr("حوّل فكرتي إلى خطوات عملية", "Turn my idea into actionable steps"), tr("حل المعادلة x^2 + 5x + 6 = 0", "Solve the equation x^2 + 5x + 6 = 0"), tr("أنشئ لي اختبارًا تفاعليًا من 3 أسئلة", "Create an interactive 3-question quiz")].map(prompt => <button key={prompt} onClick={() => { setComposer(prompt); composerRef.current?.focus(); }}><Zap size={14} />{prompt}</button>)}
                </div>
              </div>
            ) : (
              <div className="message-stack">
                {activeConversation.messages.map(message => (
                  <div className={`message-row ${message.role}`} key={message.id}>
                    <div className="message-avatar">{message.role === "assistant" ? <span>Cz</span> : <span>{tr("أنت", "You")}</span>}</div>
                    <div className="message-body"><div className="message-meta"><b>{message.role === "assistant" ? SITE_CONFIG.name : tr("أنت", "You")}</b>{message.role === "assistant" && message.model ? <small className="msg-model">{message.model}</small> : null}{message.tokens ? <span className="msg-tokens">{message.tokens.toLocaleString(lang === "ar" ? "ar-SA" : "en-US")} {tr("توكن", "tokens")}</span> : null}<span>{formatTime(message.createdAt, lang)}</span></div><div className="message-content"><RichMessage content={message.content} /></div>{message.role === "assistant" && message.content && <div className="message-actions"><button onClick={() => copyMessage(message.content)}><Copy size={13} /> {tr("نسخ الرد", "Copy reply")}</button><button onClick={() => downloadPdf(message)}><Download size={13} /> {tr("تحميل PDF", "Download PDF")}</button><button><RotateCcw size={13} /> {tr("إعادة المحاولة", "Retry")}</button></div>}</div>
                  </div>
                ))}
                {isSending && <div className="message-row assistant"><div className="message-avatar"><span>Cz</span></div><div className="message-body"><div className="message-meta"><b>{SITE_CONFIG.name}</b><span>{activeAttachmentCount ? tr("يحلل المرفقات الآن", "Analyzing attachments now") : mode === "agent" ? tr("يعمل بخطوات...", "Working step by step...") : tr("يكتب الآن", "Typing now")}</span></div>{activeAttachmentCount ? <div className="attachment-analysis glass"><LoaderCircle className="spin" size={16} /><span>{tr(`جاري تحليل ${activeAttachmentCount} مرفق مع النموذج...`, `Analyzing ${activeAttachmentCount} attachment(s) with the model...`)}</span></div> : mode === "agent" ? <div className="agent-activity glass"><Wrench className="spin" size={15} /><span>{agentActivity || tr("أخطط للخطوات وأستخدم الأدوات...", "Planning the steps and using tools...")}</span></div> : <div className="typing"><i /><i /><i /></div>}</div></div>}
              </div>
            )}
          </div>
            <div className="composer-wrap">
            <div className="composer glass">
              <input ref={fileInputRef} hidden type="file" multiple accept="image/*,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.css,.html,.xml,.yaml,.yml,.py,.sql,.log" onChange={event => handleFiles(event.target.files)} />
              {pendingAttachments.length > 0 && <div className="attachment-preview glass">{pendingAttachments.map(file => <div className="attachment-chip" key={file.id}>{file.kind === "image" ? <img src={file.data} alt="" /> : <FileText size={15} />}<span>{file.name}</span><button onClick={() => setPendingAttachments(prev => prev.filter(item => item.id !== file.id))} aria-label={tr(`حذف ${file.name}`, `Remove ${file.name}`)}><X size={12} /></button></div>)}</div>}
              <textarea ref={composerRef} value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); } }} placeholder={activeProvider?.supportsAttachments ? tr("اسأل أو أرفق صورة/ملفًا نصيًا...", "Ask, or attach an image/text file...") : tr("اسأل Ai - Cz أي شيء...", "Ask Ai - Cz anything...")} rows={1} />
              <div className="composer-bottom"><div className="composer-tools"><div className="mode-toggle" role="group" aria-label={tr("وضع المحادثة", "Conversation mode")}><button type="button" className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}><Bot size={14} /> Ai Chat</button><button type="button" className={`${mode === "agent" ? "active" : ""} ${agentEnabled ? "" : "locked"}`} onClick={() => { if (!agentEnabled) { toast.error(tr("ميزة Agent غير مفعّلة لهذا الجهاز. اطلب من المشرف تفعيلها.", "The Agent feature is not enabled for this device. Ask the admin to enable it.")); return; } setMode("agent"); }} title={agentEnabled ? tr("وضع الوكيل بالأدوات الحقيقية", "Agent mode with real tools") : tr("يتطلب تفعيلًا من المشرف", "Requires admin activation")}><Wrench size={14} /> Agent {!agentEnabled && <LockKeyhole size={11} />}</button></div><div className="provider-select-wrap"><button className={`provider-select ${modelPickerOpen ? "open" : ""}`} onClick={() => setModelPickerOpen(!modelPickerOpen)}><span className="provider-dot" />{activeProvider?.name ?? tr("أضف مفتاح API", "Add an API key")}<ChevronDown size={14} /></button><span className="provider-hint">{activeProvider?.model ?? tr("من الإعدادات", "from settings")}</span>{modelPickerOpen && <div className="model-picker glass"><div className="model-picker-head"><div><b>{tr("اختر النموذج", "Choose a model")}</b><span>{tr("تبديل سريع للمحادثة الحالية", "Quick switch for the current conversation")}</span></div><button onClick={() => setModelPickerOpen(false)} aria-label={tr("إغلاق", "Close")}><X size={14} /></button></div>{providers.length === 0 ? <div className="model-empty"><p>{tr("لا توجد نماذج بعد — لا يرد الموقع إلا بعد إضافة مفتاح API خاص بك.", "No models yet — the site will not respond until you add your own API key.")}</p><button onClick={() => { setModelPickerOpen(false); setSettingsOpen(true); setSettingsTab("providers"); }}>{tr("أضف مفتاح API", "Add an API key")}</button></div> : null}<div className="model-picker-list">{pickerProviders.map(provider => { const locked = Boolean(provider.premium && !provider.unlocked); if (locked) return <div className="model-option locked" key={provider.id} title={provider.description || undefined}><span className="model-option-logo">{provider.name.slice(0, 1).toUpperCase()}</span><span className="model-option-copy"><b>{provider.name} <small className="premium-badge">{provider.price ? `$${provider.price}` : tr("مدفوع", "Paid")}</small></b><small>{provider.model}</small></span><button className="model-buy" onClick={() => { setPurchaseTarget(provider); setModelPickerOpen(false); }}><LockKeyhole size={12} /> {tr("شراء", "Buy")}</button></div>; return <button className={`model-option ${provider.id === activeProviderId ? "selected" : ""}`} key={provider.id} onClick={() => { setActiveProviderId(provider.id); setModelPickerOpen(false); }}><span className="model-option-logo">{provider.name.slice(0, 1).toUpperCase()}</span><span className="model-option-copy"><b>{provider.name} {provider.premium && <small className={`premium-badge ${provider.unlocked ? "unlocked" : ""}`}>{provider.unlocked ? tr("مفتوح", "Free") : tr("مدفوع", "Paid")}</small>}</b><small>{provider.model}</small></span>{provider.id === activeProviderId && <Check size={15} />}</button>; })}</div><button className="model-add-option" onClick={() => { setModelPickerOpen(false); setSettingsOpen(true); setSettingsTab("providers"); }}><Plus size={15} /><span><b>{tr("إضافة نموذج جديد", "Add a new model")}</b><small>{tr("أضف API ومفتاحًا من الإعدادات", "Add an API and key from settings")}</small></span><ChevronDown size={14} className="rotate-left" /></button></div>}</div><button className="composer-icon" onClick={() => { setSettingsOpen(true); setSettingsTab("providers"); }}><KeyRound size={16} /></button><button className="composer-icon" disabled={!activeProvider?.supportsAttachments || isSending} onClick={() => fileInputRef.current?.click()} title={activeProvider?.supportsAttachments ? tr("إرفاق صورة أو ملف نصي", "Attach an image or text file") : tr("المرفقات غير مفعلة لهذا النموذج", "Attachments are off for this model")}><Paperclip size={16} /></button></div><button className={`send-button ${composer.trim() || pendingAttachments.length ? "ready" : ""}`} onClick={handleSend} disabled={(!composer.trim() && !pendingAttachments.length) || isSending} aria-label={tr("إرسال", "Send")}><ArrowUp size={18} /></button></div>
            </div>
            <p className="composer-note"><LockKeyhole size={12} /> {tr("لا تحفظ Ai - Cz مفاتيحك أو محادثاتك خارج هذا الجهاز", "Ai - Cz never stores your keys or chats outside this device")} <span>·</span> {quota.data?.limit ? tr(`متبقي ${quota.data.remaining} من ${quota.data.limit} رسالة اليوم`, `${quota.data.remaining} ${lang === "ar" ? "من" : "of"} ${quota.data.limit} ${lang === "ar" ? "رسالة اليوم" : "messages today"}`) : tr("الحصة غير محدودة", "Unlimited quota")} <span>·</span> {tr("اضغط Enter للإرسال", "Press Enter to send")}</p>
          </div>
        </main>

        {settingsOpen && <aside className="settings-panel glass">
          <div className="settings-header"><div><span className="eyebrow-text">{tr("مركز التحكم", "Control center")}</span><h2>{tr("الإعدادات", "Settings")}</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
          <div className="settings-tabs"><button className={settingsTab === "providers" ? "active" : ""} onClick={() => setSettingsTab("providers")}><Gauge size={15} /> {tr("مزودو API", "API providers")}</button><button className={settingsTab === "identity" ? "active" : ""} onClick={() => setSettingsTab("identity")}><Sparkles size={15} /> {tr("الهوية", "Identity")}</button></div>
              {settingsTab === "providers" ? <div className="settings-scroll"><div className="settings-intro"><div className="intro-icon"><FileKey2 size={19} /></div><div><h3>{tr("مفاتيحك، تحت سيطرتك", "Your keys, under your control")}</h3><p>{tr("تُشفّر المفاتيح على جهازك وتُرسل للخادم وقت الطلب فقط.", "Keys are encrypted on your device and sent to the server only when needed.")}</p></div></div><div className="section-label"><span>{tr("المزودون المحفوظون", "Saved providers")}</span><span className="count-badge">{providers.length}</span></div><div className="provider-list">{providers.map(provider => <div className={`provider-card ${provider.id === activeProviderId ? "active" : ""} ${provider.premium && !provider.unlocked ? "locked" : ""}`} key={provider.id} onClick={() => { if (provider.premium && !provider.unlocked) { setPurchaseTarget(provider); return; } setActiveProviderId(provider.id); }}><div className="provider-card-top"><div className="provider-logo">{provider.kind === "demo" ? "✦" : provider.name.slice(0, 1).toUpperCase()}</div><div className="provider-info"><b>{provider.name}</b><span>{provider.model}{provider.supportsAttachments ? tr(" · مرفقات", " · attachments") : ""}{provider.premium ? ` · ${provider.price ? `$${provider.price}` : tr("مدفوع", "Paid")}` : ""}</span></div><div className={`provider-state ${provider.lastCheck === "failed" ? "failed" : provider.lastCheck === "ready" || provider.isDemo ? "ready" : "pending"}`}><i />{provider.lastCheck === "failed" ? tr("فشل", "Failed") : provider.lastCheck === "ready" || provider.isDemo ? tr("جاهز", "Ready") : tr("غير متحقق", "Unverified")}</div></div><div className="provider-card-bottom">{provider.sharedProviderId ? (provider.premium && !provider.unlocked ? <button className="buy-provider" onClick={event => { event.stopPropagation(); setPurchaseTarget(provider); }}><LockKeyhole size={13} /> {tr("شراء النموذج", "Buy the model")}</button> : <span className="shared-note"><ShieldCheck size={13} /> {tr("نموذج عام جاهز", "Ready public model")}</span>) : <><button onClick={event => { event.stopPropagation(); handleVerify(provider); }} disabled={verifyMutation.isPending}>{verifyMutation.isPending ? "جارٍ التحقق..." : tr("تحقق من الاتصال", "Check connection")}</button><button className="delete-provider" onClick={event => { event.stopPropagation(); removeProvider(provider); }}><Trash2 size={14} /></button></>}</div></div>)}</div><div className="add-api-title"><span>{tr("إضافة API جديد", "Add a new API")}</span><span className="line" /></div><div className="api-form"><label>{tr("اسم المزود", "Provider name")}<input value={draft.name} onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))} placeholder={tr("مثال: حسابي في OpenAI", "e.g. My OpenAI account")} /></label><label>{tr("نوع الـ API", "API type")}<select value={draft.kind} onChange={event => handleDraftKindChange(event.target.value as DraftProvider["kind"])}>{Object.entries(PROVIDER_META).map(([key, meta]) => <option key={key} value={key}>{lang === "ar" ? meta.label : meta.labelEn} — {lang === "ar" ? meta.hint : meta.hintEn}</option>)}</select></label><div className="form-two">{draft.kind === "czai" ? <label>{tr("نموذج Cz", "Cz model")}<select value={CZ_MODEL_PRESETS.includes(draft.model) ? draft.model : "__custom"} onChange={event => handleCzModelChange(event.target.value)}>{CZ_MODEL_PRESETS.map(model => <option key={model} value={model}>{model}</option>)}<option value="__custom">{tr("خيار آخر…", "Another option…")}</option></select></label> : <label>{tr("اسم النموذج", "Model name")}<input value={draft.model} onChange={event => setDraft(prev => ({ ...prev, model: event.target.value }))} placeholder="gpt-4o-mini" /></label>}<label>{tr("رابط Endpoint", "Endpoint URL")}<input dir="ltr" value={draft.endpoint} onChange={event => setDraft(prev => ({ ...prev, endpoint: event.target.value }))} placeholder="https://..." /></label></div>{draft.kind === "czai" && !CZ_MODEL_PRESETS.includes(draft.model) && <label>{tr("اسم النموذج (مخصص)", "Model name (custom)")}<input dir="ltr" value={draft.model} onChange={event => setDraft(prev => ({ ...prev, model: event.target.value }))} placeholder="cz-model-name" /></label>}<label>{tr("مفتاح API", "API key")}<input dir="ltr" type="password" value={draft.apiKey} onChange={event => setDraft(prev => ({ ...prev, apiKey: event.target.value }))} placeholder="sk-••••••••••••••••" /></label><label className="check-row"><input type="checkbox" checked={draft.supportsAttachments} onChange={event => setDraft(prev => ({ ...prev, supportsAttachments: event.target.checked }))} /><span><b>{tr("تفعيل تحليل المرفقات", "Enable attachment analysis")}</b><small>{tr("فعّلها فقط إذا كان النموذج يدعم الرؤية أو إدخال الملفات", "Enable only if the model supports vision or file input")}</small></span></label><button className="add-api-button" onClick={handleAddProvider}><Plus size={17} /> {tr("إضافة والتحقق لاحقًا", "Add and verify later")}</button><p className="form-footnote"><LockKeyhole size={13} /> {tr("تشفير AES-GCM محلي · لا يظهر المفتاح مرة أخرى", "Local AES-GCM encryption · the key is never shown again")}</p></div></div> : <div className="settings-scroll identity-tab"><div className="identity-preview"><div className="brand-mark large"><span>Cz</span><i /></div><h3>{SITE_CONFIG.name}</h3><p>{SITE_CONFIG.tagline}</p></div><div className="identity-info"><div><span>{tr("اسم الموقع الحالي", "Current site name")}</span><b>{SITE_CONFIG.name}</b></div><div><span>{tr("مكان التعديل", "Where to edit")}</span><code>client/src/config/site.ts</code></div><div><span>{tr("وصف العلامة", "Brand description")}</span><b>{SITE_CONFIG.description}</b></div></div><div className="tip-card"><Sparkles size={16} /><p>{tr("لتغيير اسم الموقع أو إضافة مزود افتراضي جديد، عدّل ملف الإعدادات ثم أعد تشغيل المشروع. أما المفاتيح الحساسة فأضفها من هذه الشاشة لتظل مشفرة محليًا.", "To change the site name or add a default provider, edit the settings file and restart the project. Add sensitive keys from this screen so they stay encrypted locally.")}</p></div></div>}
        </aside>}

        {geoModalOpen && !geoGranted && <div className="geo-modal-backdrop" role="dialog" aria-modal="true">
          <div className="geo-modal glass">
            <div className="geo-modal-icon"><MapPin size={22} /></div>
            <h3>{tr("السماح الوصول للموقع", "Allow access to the site")}</h3>
            <p>{tr("لتشغيل الموقع على هذا الجهاز، اسمح بالوصول إلى موقعك. نستخدم موقعك المباشر لعرضه للمشرف فقط، ولا نشاركه مع أي طرف خارجي.", "To run the site on this device, allow access to your location. We use your live location only to show it to the admin; we never share it with anyone.")}</p>
            <div className="geo-modal-actions">
              <button className="geo-allow" onClick={allowGeo}><MapPin size={15} /> {tr("السماح بالوصول للموقع", "Allow site access")}</button>
            </div>
            <small className="geo-hint">{tr("سيظهر هذا الطلب في كل مرة حتى تسمح بالوصول. إن رفضت سابقًا، فعّل الموقع من إعدادات المتصفح.", "This prompt keeps appearing until you allow access. If you denied it before, enable location in your browser settings.")}</small>
          </div>
        </div>}

        {mailOpen && <aside className="mail-drawer glass">
          <div className="mail-head">
            <div><span className="eyebrow-text">{tr("الرسائل", "Messages")}</span><h2>{tr("البريد", "Inbox")}</h2></div>
            <button className="icon-button" onClick={() => setMailOpen(false)} aria-label={tr("إغلاق", "Close")}><X size={18} /></button>
          </div>
          <div className="mail-list">
            {mailList.length === 0 ? <div className="mail-empty"><MailOpen size={26} /><span>{tr("لا توجد رسائل بعد", "No messages yet")}</span><small>{tr("ستظهر هنا رسائل المشرف", "Admin messages appear here")}</small></div> : mailList.map(message => (
              <div className={`mail-item ${message.read ? "" : "unread"} ${openMessageId === message.id ? "open" : ""}`} key={message.id}>
                <button className="mail-item-head" onClick={() => openMessage(message.id)}>
                  <div className="mail-avatar"><ShieldCheck size={15} /></div>
                  <div className="mail-item-info"><b>{message.title}</b><small>{tr("من المشرف", "From the admin")}</small></div>
                  <div className="mail-item-side">{!message.read && <span className="mail-dot" />}<span className="mail-time">{formatTime(message.createdAt, lang)}</span><ChevronDown size={14} className={`mail-caret ${openMessageId === message.id ? "open" : ""}`} /></div>
                </button>
                {openMessageId === message.id && <p className="mail-body">{message.body}</p>}
              </div>
            ))}
          </div>
        </aside>}

        <button className={`support-fab ${supportOpen ? "open" : ""}`} onClick={() => { const next = !supportOpen; setSupportOpen(next); if (next) { supportThread.refetch(); supportSummary.refetch(); } }} aria-label={tr("الدعم الفني", "Live support")} title={tr("الدعم الفني — دردشة سريعة مع المشرف", "Live support — quick chat with the admin")}>
          {supportOpen ? <X size={20} /> : <Headset size={22} />}
          {!supportOpen && (supportSummary.data?.unread ?? 0) > 0 && <span className="support-badge">{(supportSummary.data?.unread ?? 0) > 9 ? "9+" : fmtNum(supportSummary.data?.unread ?? 0)}</span>}
        </button>
        {supportOpen && <div className="support-widget glass">
          <div className="support-head">
            <div className="support-avatar"><Headset size={16} /></div>
            <div className="support-head-info"><b>{tr("الدعم الفني", "Live support")}</b><span><i className="online-dot" /> {tr("متصل — نرد بسرعة", "Online — we reply fast")}</span></div>
            <button className="icon-button" onClick={() => setSupportOpen(false)} aria-label={tr("إغلاق", "Close")}><X size={17} /></button>
          </div>
          <div className="support-messages" ref={supportScrollRef}>
            {(!supportThread.data || supportThread.data.messages.length === 0) ? <div className="support-hello"><p>{tr("مرحبًا بك! كيف يمكننا مساعدتك؟", "Welcome! How can we help you?")}</p><small>{tr("اكتب رسالتك وسيصل إشعار للمشرف فورًا.", "Type your message — the admin is notified instantly.")}</small></div> : supportThread.data.messages.map(message => (
              <div className={`support-msg ${message.sender}`} key={message.id}>
                <div className="support-bubble">{message.body}</div>
                <small>{message.sender === "admin" ? tr("من المشرف", "From the admin") : tr("أنت", "You")} · {formatTime(message.createdAt, lang)}</small>
              </div>
            ))}
            {sendSupport.isPending && <div className="support-msg user sending"><div className="support-bubble"><LoaderCircle className="spin" size={14} /></div></div>}
          </div>
          <div className="support-composer">
            <textarea value={supportDraft} onChange={event => setSupportDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (supportDraft.trim() && !sendSupport.isPending) sendSupport.mutate({ code: deviceCode, body: supportDraft.trim() }); } }} placeholder={tr("اكتب رسالتك للدعم...", "Write your support message...")} rows={1} />
            <button className="support-send" disabled={!supportDraft.trim() || sendSupport.isPending} onClick={() => { if (supportDraft.trim()) sendSupport.mutate({ code: deviceCode, body: supportDraft.trim() }); }} aria-label={tr("إرسال", "Send")}><Send size={16} /></button>
          </div>
        </div>}

        {purchaseTarget && (() => { const username = (siteConfig.data?.purchaseTelegram ?? "c5_xc").replace(/^@/, ""); const whatsapp = siteConfig.data?.purchaseWhatsapp ?? "https://wa.me/message/R4J6XXSDMXB6D1"; const message = (siteConfig.data?.purchaseMessage ?? tr("هل تريد شراء نموذج {model}؟", "Buy the model {model}?")).replace(/\{model\}/g, purchaseTarget.name); return <div className="purchase-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPurchaseTarget(null)}><div className="purchase-modal glass" onClick={event => event.stopPropagation()}><button className="purchase-close" onClick={() => setPurchaseTarget(null)} aria-label={tr("إغلاق", "Close")}><X size={17} /></button><div className="purchase-icon"><LockKeyhole size={24} /></div><h3>{message}</h3><p className="purchase-price">{purchaseTarget.price ? <><b>${purchaseTarget.price}</b><span>{tr("دفعة واحدة", "one-time")}</span></> : <span>{tr("يُحدَّد السعر بالتواصل", "Price set on contact")}</span>}</p>{purchaseTarget.description ? <p className="purchase-desc">{purchaseTarget.description}</p> : null}<p className="purchase-note">{tr("للشراء تواصل معنا عبر إحدى القنوات التالية، وسيتم تفعيل النموذج لحسابك بعد التأكيد.", "To buy, contact us via one of the channels below; the model is activated on your account after confirmation.")}</p><a className="purchase-whatsapp" href={whatsapp} target="_blank" rel="noreferrer"><MessageCircle size={19} /><span><b>{tr("الشراء عبر واتساب", "Buy via WhatsApp")}</b><small dir="ltr">{whatsapp.replace(/^https?:\/\//, "")}</small></span><ExternalLink size={14} /></a><div className="purchase-telegram"><span className="purchase-telegram-label"><Send size={15} /> {tr("أو عبر تيليجرام", "or via Telegram")}</span><div className="purchase-telegram-row"><a className="purchase-telegram-link" href={`https://t.me/${username}`} target="_blank" rel="noreferrer">@{username}</a><button className="purchase-copy" onClick={() => { navigator.clipboard.writeText(`@${username}`).then(() => { setTelegramCopied(true); toast.success(tr("تم نسخ يوزر تيليجرام", "Telegram username copied")); window.setTimeout(() => setTelegramCopied(false), 2000); }).catch(() => undefined); }}>{telegramCopied ? <Check size={14} /> : <Copy size={14} />}{telegramCopied ? tr("تم النسخ", "Copied") : tr("نسخ", "Copy")}</button></div></div></div></div>; })()}
      </div>
    </div>
  );
}
