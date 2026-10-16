import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Ban, BarChart3, Bot, Copy, Check, CreditCard, ExternalLink, Eye, Globe2, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Pause, Play, Plus, RefreshCw, RotateCcw, Save, Search, Settings2, ShieldCheck, Trash2, Users, FileSearch, Gauge, Wrench, MapPin, Fingerprint, MessageSquareText, Timer, X, Mail, MailOpen, Headset, Send } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { formatTokenLimit } from "@/lib/model-limits";

type Tab = "overview" | "stats" | "providers" | "access" | "subscriptions" | "site" | "visitors" | "devices" | "mail" | "support" | "chats" | "audit";
// Admin console — providers, purchase contacts, device auditing.
type ProviderKind = "openai" | "anthropic" | "google" | "openrouter" | "custom" | "czai";
const ADMIN_KIND_LABELS: Record<ProviderKind, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", openrouter: "OpenRouter", custom: "مخصص (OpenAI-compatible)", czai: "نماذج Cz (CzAI)" };
const CZ_MODEL_PRESETS = ["cz-pro", "cz-reasoner", "cz-fast", "cz-coder", "cz-vision"];
const providerDefaults: Record<ProviderKind, { model: string; endpoint: string }> = { openai: { model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1" }, anthropic: { model: "claude-3-5-sonnet-latest", endpoint: "https://api.anthropic.com/v1" }, google: { model: "gemini-2.0-flash", endpoint: "https://generativelanguage.googleapis.com" }, openrouter: { model: "openai/gpt-4o-mini", endpoint: "https://openrouter.ai/api/v1" }, custom: { model: "your-model", endpoint: "" }, czai: { model: "cz-reasoner", endpoint: "https://api.openai.com/v1" } };
// One-click quick-fill presets for chat models (they all speak the OpenAI-compatible protocol).
const ENDPOINT_PRESETS: Array<{ id: string; name: string; kind: ProviderKind; endpoint: string; model: string }> = [
  { id: "venice", name: "Venice Uncensored — نص بدون قيود", kind: "custom", endpoint: "https://api.venice.ai/api/v1", model: "venice-uncensored" },
  { id: "or-llama", name: "OpenRouter · Llama 3.3 70B", kind: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct" },
  { id: "or-deepseek", name: "OpenRouter · DeepSeek Chat", kind: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  { id: "or-qwen", name: "OpenRouter · Qwen 2.5 72B", kind: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "qwen/qwen-2.5-72b-instruct" },
];
// Literal endpoint URLs kept ready for direct copy (chat + video). Video endpoints are for the media feature.
const ENDPOINT_LINKS: Array<{ label: string; url: string; video?: boolean }> = [
  { label: "Venice AI — نص بدون قيود", url: "https://api.venice.ai/api/v1/chat/completions" },
  { label: "OpenRouter — Llama / DeepSeek / Qwen", url: "https://openrouter.ai/api/v1/chat/completions" },
  { label: "Runway Gen-3 Alpha — فيديو", url: "https://api.dev.runwayml.com/v1/text_to_video", video: true },
  { label: "MiniMax / Hailuo — فيديو", url: "https://api.minimax.io/v1/text_to_video", video: true },
];
const initialProvider = { name: "", kind: "openai" as ProviderKind, model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1", apiKey: "", premium: false, price: 0, description: "", supportsAttachments: false };
const initialSettings = { siteName: "Ai - Cz", tagline: "مختبر الذكاء الخاص بك", description: "مساعدك الذكي الخاص", telegramUsername: "qe_3z", purchaseWhatsapp: "https://wa.me/message/R4J6XXSDMXB6D1", purchaseTelegram: "c5_xc", purchaseMessage: "هل تريد شراء نموذج {model}؟", subscriptionRequired: false, dailyMessageLimit: 20, maintenanceMode: false };

/** Short two-note chime used to alert the admin about a new support message. */
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [659.25, 880].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = now + index * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  } catch {
    /* audio is best-effort */
  }
}

function AdminLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const ipInfo = trpc.admin.session.myIp.useQuery();
  const blocked = ipInfo.data ? !ipInfo.data.allowed : false;
  const login = trpc.admin.session.login.useMutation({ onSuccess: () => { onLoggedIn(); toast.success("تم فتح لوحة الإدارة بأمان"); }, onError: error => toast.error(error.message) });
  return <div className="admin-auth-page"><div className="admin-auth-card"><div className="admin-brand"><div className="admin-brand-mark">Cz<span>✦</span></div><span>Ai - Cz / CONTROL</span></div><div className="admin-auth-icon"><ShieldCheck size={25} /></div><h1>لوحة التحكم الخاصة</h1><p>أدخل كلمة المرور الموجودة في متغير <code>ADMIN_PASSWORD</code> على خادمك.</p><div className="admin-auth-note" dir="ltr"><span className="live-dot" /> IP: {ipInfo.data?.ip ?? "…"}{ipInfo.data ? (ipInfo.data.allowed ? " · مسموح" : " · محجوب") : ""}</div>{blocked && <div className="admin-auth-note danger" dir="rtl">هذه الشبكة غير مصرّح لها بالدخول إلى لوحة الإدارة.</div>}<form onSubmit={event => { event.preventDefault(); login.mutate({ password }); }}><label>كلمة مرور المشرف<input autoFocus type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="••••••••••••" /></label><button className="admin-primary" disabled={login.isPending || !password || blocked}>{login.isPending ? "جارٍ التحقق..." : "دخول آمن"}<KeyRound size={16} /></button></form><div className="admin-auth-note"><span className="live-dot" /> جلسة مشفرة · لا يتم تخزين كلمة المرور</div></div></div>;
}

export default function Admin() {
  const session = trpc.admin.session.me.useQuery();
  const [tab, setTab] = useState<Tab>("overview");
  const logout = trpc.admin.session.logout.useMutation({ onSuccess: () => session.refetch() });
  if (session.isLoading) return <div className="admin-loading"><RefreshCw className="spin" /> جارٍ فحص جلسة المشرف...</div>;
  if (!session.data) return <AdminLogin onLoggedIn={() => session.refetch()} />;
  return <AdminShell tab={tab} setTab={setTab} onLogout={() => logout.mutate()}>{tab === "overview" && <Overview onNavigate={setTab} />}{tab === "stats" && <Stats />}{tab === "providers" && <Providers />}{tab === "access" && <AccessRules />}{tab === "subscriptions" && <Subscriptions />}{tab === "site" && <SiteSettings />}{tab === "visitors" && <Visitors />}{tab === "devices" && <Devices />}{tab === "mail" && <MailCenter />}{tab === "support" && <SupportCenter />}{tab === "chats" && <Chats />}{tab === "audit" && <Audit />}</AdminShell>;
}

function AdminShell({ tab, setTab, onLogout, children }: { tab: Tab; setTab: (tab: Tab) => void; onLogout: () => void; children: ReactNode }) {
  const support = trpc.admin.support.summary.useQuery(undefined, { refetchInterval: 5000 });
  const unreadSupport = support.data?.unread ?? 0;
  const prevUnread = useRef<number | null>(null);
  useEffect(() => {
    // Chime only when a *new* support message arrives while the admin is watching.
    if (prevUnread.current !== null && unreadSupport > prevUnread.current) playChime();
    prevUnread.current = unreadSupport;
  }, [unreadSupport]);
  const items: Array<{ id: Tab; icon: typeof LayoutDashboard; label: string; hint: string }> = [{ id: "overview", icon: LayoutDashboard, label: "نظرة عامة", hint: "مركز القيادة" }, { id: "stats", icon: BarChart3, label: "الإحصائيات", hint: "التوكن والنماذج" }, { id: "providers", icon: KeyRound, label: "مزودو الذكاء", hint: "API والنماذج" }, { id: "access", icon: ShieldCheck, label: "تصاريح الوصول", hint: "IP أو بصمة" }, { id: "subscriptions", icon: CreditCard, label: "الاشتراكات", hint: "نماذج لأشخاص/الجميع" }, { id: "site", icon: Globe2, label: "الإعدادات", hint: "الحصة والصيانة" }, { id: "visitors", icon: Users, label: "الزوار والحظر", hint: "IP والنشاط" }, { id: "devices", icon: Fingerprint, label: "الأجهزة والتفعيل", hint: "كود · Agent · حظر" }, { id: "mail", icon: Mail, label: "البريد", hint: "رسائل للزوار" }, { id: "support", icon: Headset, label: "الدعم الفني", hint: "دردشة مباشرة" }, { id: "chats", icon: MessageSquareText, label: "المحادثات", hint: "محفوظات الزوار" }, { id: "audit", icon: FileSearch, label: "سجل التدقيق", hint: "كل العمليات" }];
  return <div className="admin-shell" dir="rtl"><aside className="admin-sidebar glass"><div className="admin-side-brand"><div className="admin-brand-mark">Cz<span>✦</span></div><div><b>Ai - Cz</b><small>CONTROL CENTER</small></div></div><div className="admin-side-label">مركز الإدارة</div><nav>{items.map(item => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><item.icon size={17} /><span><b>{item.label}</b><small>{item.hint}</small></span>{item.id === "support" && unreadSupport > 0 && <em className="admin-nav-badge">{unreadSupport > 99 ? "99+" : unreadSupport}</em>}{tab === item.id && <i />}</button>)}</nav><div className="admin-side-bottom"><div className="admin-secure"><ShieldCheck size={16} /><span><b>وضع محمي</b><small>ADMIN SESSION</small></span></div><button className="admin-logout" onClick={onLogout}><LogOut size={15} /> تسجيل الخروج</button></div></aside><main className="admin-main"><header className="admin-topbar"><div><span className="admin-overline">AI - CZ / COMMAND CENTER</span><h1>{items.find(item => item.id === tab)?.label}</h1></div><div className="admin-top-actions"><span><i className="live-dot" /> النظام يعمل</span><a href="/" target="_blank" rel="noreferrer"><ExternalLink size={15} /> فتح الموقع</a></div></header>{children}</main></div>;
}

function Overview({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const overview = trpc.admin.overview.useQuery();
  const config = trpc.admin.settings.get.useQuery();
  const providers = trpc.admin.providers.list.useQuery();
  const cards = [{ label: "إجمالي الزوار", value: overview.data?.totalVisitors ?? 0, icon: Users, tone: "lime" }, { label: "طلبات الذكاء", value: overview.data?.requests ?? 0, icon: Activity, tone: "blue" }, { label: "رسائل اليوم", value: overview.data?.messagesToday ?? 0, icon: Gauge, tone: "violet" }, { label: "عناوين محظورة", value: overview.data?.blockedIps ?? 0, icon: Ban, tone: "red" }];
  return <div className="admin-content"><div className="admin-hero"><div><span className="admin-overline">مرحبًا بك في غرفة القيادة</span><h2>كل شيء تحت سيطرتك<span>.</span></h2><p>حصص يومية، نماذج مدفوعة، تصاريح IP، وتدقيق كامل لكل العمليات.</p></div><div className="admin-hero-orb"><div>Cz</div><i /><i /></div></div><div className="admin-stat-grid">{cards.map(card => <div className={`admin-stat-card ${card.tone}`} key={card.label}><div className="admin-stat-top"><span>{card.label}</span><card.icon size={17} /></div><strong>{card.value.toLocaleString("ar-SA")}</strong><small><i className="live-dot" /> بيانات حية من قاعدة البيانات</small></div>)}</div><div className="admin-grid-2"><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">حماية الاستخدام</span><h3>حصة الرسائل اليومية</h3></div><button onClick={() => onNavigate("site")}><Settings2 size={15} /> تعديل</button></div><div className="quota-card"><div className="quota-ring"><b>{config.data?.dailyMessageLimit ?? 20}</b><small>رسالة / IP</small></div><div><b>{config.data?.dailyMessageLimit ? `كل عنوان IP يستطيع إرسال ${config.data.dailyMessageLimit} رسالة يوميًا` : "الحصة غير محدودة"}</b><span>{config.data?.maintenanceMode ? "وضع الصيانة مفعل حاليًا" : "الحماية تعمل من الخادم ولا يمكن تجاوزها من المتصفح"}</span></div></div></section><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">بوابة الذكاء</span><h3>النماذج المنشورة والمدفوعة</h3></div><button onClick={() => onNavigate("providers")}><Plus size={15} /> إدارة</button></div>{providers.data?.length ? <div className="mini-provider-list">{providers.data.slice(0, 5).map(provider => <div key={provider.id}><span className="mini-provider-icon">{provider.name.slice(0, 1)}</span><span><b>{provider.name}{provider.premium ? (provider.price ? ` · $${provider.price}` : " · مدفوع") : ""}</b><small>{provider.model}</small></span><i className={provider.enabled ? "live-dot" : "offline-dot"} /></div>)}</div> : <div className="admin-empty"><KeyRound size={23} /><span>لم تضف مزودًا عامًا بعد</span><button onClick={() => onNavigate("providers")}>أضف أول API</button></div>}</section></div></div>;
}

function Stats() {
  const devicesQuery = trpc.admin.devices.list.useQuery();
  const providersQuery = trpc.admin.providers.list.useQuery();
  const devices = devicesQuery.data?.devices ?? [];
  const usage = devicesQuery.data?.usage ?? [];
  const reported = devicesQuery.data?.reportedProviders ?? [];
  const providers = providersQuery.data ?? [];
  const now = Date.now();

  const totalPrompt = usage.reduce((sum, row) => sum + row.promptTokens, 0);
  const totalCompletion = usage.reduce((sum, row) => sum + row.completionTokens, 0);
  const totalMessages = usage.reduce((sum, row) => sum + row.messages, 0);
  const totalTokens = totalPrompt + totalCompletion;
  const peopleWithModels = new Set(reported.map(item => item.code)).size;
  const publicNow = providers.filter(provider => !provider.premium || Boolean(provider.publicUntil && new Date(provider.publicUntil).getTime() > now)).length;

  let activeGrants = 0;
  let pausedGrants = 0;
  for (const device of devices) {
    for (const value of Object.values(parseGrantsClient(device.providerGrants))) {
      if (grantActive(value)) activeGrants += 1;
      else if (grantPaused(value)) pausedGrants += 1;
    }
  }

  const cards: Array<{ label: string; value: number; icon: typeof Users; tone: string }> = [
    { label: "أشخاص أضافوا نماذج", value: peopleWithModels, icon: Users, tone: "lime" },
    { label: "إجمالي التوكن المستهلك", value: totalTokens, icon: Gauge, tone: "blue" },
    { label: "إجمالي الرسائل", value: totalMessages, icon: MessageSquareText, tone: "violet" },
    { label: "اشتراكات فعّالة", value: activeGrants, icon: CreditCard, tone: "lime" },
    { label: "موقوفة مؤقتًا", value: pausedGrants, icon: Pause, tone: "red" },
    { label: "نماذج متاحة للجميع الآن", value: publicNow, icon: Globe2, tone: "blue" },
  ];

  const modelsByCode = (code: string) => reported.filter(item => item.code === code);
  const usageRows = (code: string) => usage.filter(row => row.code === code);
  const nameFor = (id: number) => providers.find(item => item.id === id)?.name ?? `نموذج #${id}`;
  const people = Array.from(new Set([...reported.map(item => item.code), ...usage.map(row => row.code), ...devices.map(device => device.code)]))
    .map(code => ({ code, added: modelsByCode(code).length, tokens: usageRows(code).reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0), messages: usageRows(code).reduce((sum, row) => sum + row.messages, 0) }))
    .filter(person => person.added > 0 || person.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || b.added - a.added);

  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">LIVE ANALYTICS</span><h2>الإحصائيات</h2><p>كم شخصًا أضاف نماذج، وكم توكن استهلك الجميع، وكل نموذج (اسمه ورابطه وحدّه) ومن يستخدمه — كل شيء في مكان واحد.</p></div><div className="secret-badge"><BarChart3 size={16} /> أرقام حية من قاعدة البيانات</div></div>
      <div className="admin-stat-grid">{cards.map(card => <div className={`admin-stat-card ${card.tone}`} key={card.label}><div className="admin-stat-top"><span>{card.label}</span><card.icon size={17} /></div><strong>{card.value.toLocaleString("ar-SA")}</strong><small><i className="live-dot" /> تحديث مباشر</small></div>)}</div>

      <section className="admin-panel glass stats-panel">
        <div className="admin-panel-head"><div><span className="admin-overline">PEOPLE</span><h3>الأشخاص وتفاصيلهم <b>{people.length}</b></h3></div><button onClick={() => devicesQuery.refetch()}><RefreshCw size={15} /> تحديث</button></div>
        {people.length === 0 ? <div className="admin-empty"><Users size={23} /><span>لا يوجد نشاط بعد — لم يضف أحد نماذج أو يستخدم توكنًا حتى الآن.</span></div> : <div className="stats-people">
          {people.map(person => {
            const device = devices.find(item => item.code === person.code);
            const grants = Object.entries(parseGrantsClient(device?.providerGrants));
            return <details className="stats-person" key={person.code}>
              <summary>
                <span className="stats-person-code"><Fingerprint size={13} /> <span dir="ltr">{person.code}</span></span>
                <span className="stats-person-stats"><i>أضاف {person.added} نموذج</i><i>{person.tokens.toLocaleString("ar-SA")} توكن</i><i>{person.messages.toLocaleString("ar-SA")} رسالة</i></span>
              </summary>
              <div className="stats-person-body">
                {device && <div className="drawer-grid"><div><small>IP</small><b dir="ltr">{device.ip ?? "—"}</b></div><div><small>الموقع</small><b>{[device.city, device.region, device.country].filter(Boolean).join(" · ") || "غير معروف"}</b></div><div><small>آخر ظهور</small><b>{formatWhen(device.lastSeen)}</b></div></div>}
                {modelsByCode(person.code).length > 0 && <div className="drawer-block"><b><KeyRound size={13} /> نماذج أضافها بنفسه</b><div className="reported-list">{modelsByCode(person.code).map((item, index) => <span className="reported-chip" key={index}><b>{item.name}</b><small dir="ltr">{item.kind} · {item.model}</small><small dir="ltr">{item.endpoint || "Endpoint افتراضي"}</small><small>حد النموذج: {formatTokenLimit(item.model)}</small></span>)}</div></div>}
                <div className="drawer-block"><b><CreditCard size={13} /> اشتراكاته من نماذج الموقع</b>{grants.length === 0 ? <small className="drawer-muted">لا يوجد</small> : <div className="reported-list">{grants.map(([key, value]) => { const id = Number(key); const provider = providers.find(item => item.id === id); const used = usage.find(row => row.code === person.code && row.providerId === id); const active = grantActive(value); return <span className={`reported-chip ${active ? "granted" : "revoked"}`} key={id}><b>{provider?.name ?? nameFor(id)}</b><small dir="ltr">{provider?.model ?? "—"}</small><small dir="ltr">{provider?.endpoint || "Endpoint افتراضي"}</small><small>حد النموذج: {formatTokenLimit(provider?.model)}</small><small>{active ? (value.expiresAt ? `حتى ${formatWhen(new Date(value.expiresAt))}` : "مدى الحياه") : "موقوف مؤقتًا"} · {((used?.promptTokens ?? 0) + (used?.completionTokens ?? 0)).toLocaleString("ar-SA")} توكن</small></span>; })}</div>}</div>
              </div>
            </details>;
          })}
        </div>}
      </section>

      <section className="admin-panel glass stats-panel">
        <div className="admin-panel-head"><div><span className="admin-overline">MODELS</span><h3>كل النماذج · الحدود والاستخدام</h3></div><button onClick={() => providersQuery.refetch()}><RefreshCw size={15} /> تحديث</button></div>
        {providers.length === 0 ? <div className="admin-empty"><KeyRound size={23} /><span>لا توجد نماذج. أضفها من تبويب «مزودو الذكاء».</span></div> : <div className="stats-models">
          {providers.map(provider => {
            const isPublic = !provider.premium || Boolean(provider.publicUntil && new Date(provider.publicUntil).getTime() > now);
            const grantedTo = devices.filter(device => { const grant = parseGrantsClient(device.providerGrants)[String(provider.id)]; return grantActive(grant) || grantPaused(grant); });
            const used = usage.filter(row => row.providerId === provider.id).reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0);
            return <div className="stats-model" key={provider.id}>
              <div className="stats-model-head"><b>{provider.name}{provider.premium ? <i className="subs-tag">مدفوع{provider.price ? ` · $${provider.price}` : ""}</i> : <i className="subs-tag free">مجاني</i>}</b><span className={isPublic ? "state-pill ready" : "state-pill danger"}>{isPublic ? "متاح للجميع" : "مقفل للجميع"}</span></div>
              <div className="stats-model-grid">
                <div><small>اسم النموذج</small><b dir="ltr">{provider.model}</b></div>
                <div><small>رابط API (Endpoint)</small><b dir="ltr">{provider.endpoint || "افتراضي"}</b></div>
                <div><small>حد النموذج (توكن)</small><b>{formatTokenLimit(provider.model)}</b></div>
                <div><small>استُهلك منه</small><b>{used.toLocaleString("ar-SA")} توكن</b></div>
                <div><small>ممنوح لعدد أشخاص</small><b>{grantedTo.length}</b></div>
                <div><small>النوع</small><b dir="ltr">{provider.kind}</b></div>
              </div>
              {grantedTo.length > 0 && <div className="device-chips stats-model-chips">{grantedTo.map(device => { const active = grantActive(parseGrantsClient(device.providerGrants)[String(provider.id)]); return <span className={`provider-chip ${active ? "on" : ""}`} key={device.code}><span dir="ltr">{device.code}</span>{active ? "" : " · موقوف"}</span>; })}</div>}
            </div>;
          })}
        </div>}
      </section>
    </div>
  );
}

function Providers() {
  const list = trpc.admin.providers.list.useQuery();
  const utils = trpc.useUtils();
  const add = trpc.admin.providers.add.useMutation({ onSuccess: () => { list.refetch(); utils.site.getConfig.invalidate(); setForm(initialProvider); toast.success("تم نشر المزود للزوار"); }, onError: error => toast.error(error.message) });
  const update = trpc.admin.providers.update.useMutation({ onSuccess: () => { list.refetch(); utils.site.getConfig.invalidate(); toast.success("تم تحديث المزود"); } });
  const remove = trpc.admin.providers.delete.useMutation({ onSuccess: () => { list.refetch(); utils.site.getConfig.invalidate(); toast.success("تم حذف المزود"); }, onError: error => toast.error(error.message) });
  const removeAll = trpc.admin.providers.deleteAll.useMutation({ onSuccess: () => { list.refetch(); utils.site.getConfig.invalidate(); toast.success("تم حذف جميع النماذج"); }, onError: error => toast.error(error.message) });
  const [form, setForm] = useState(initialProvider);
  const selectedDefault = providerDefaults[form.kind];
  const applyPreset = (id: string) => { const preset = ENDPOINT_PRESETS.find(item => item.id === id); if (!preset) return; setForm({ ...form, name: preset.name, kind: preset.kind, model: preset.model, endpoint: preset.endpoint }); toast.success(`تم تعبئة القالب: ${preset.name}`); };
  const copyEndpoint = async (url: string) => { try { await navigator.clipboard.writeText(url); toast.success("تم نسخ الرابط"); } catch { toast.error("تعذّر النسخ — انسخ الرابط يدويًا"); } };
  const presetSelect = <label>قالب جاهز<select value="" onChange={event => applyPreset(event.target.value)}><option value="">— اختر قالبًا لتعبئة النموذج والرابط —</option>{ENDPOINT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>;
  const endpointBlock = <div className="endpoint-copy-block"><div className="endpoint-copy-head"><span>روابط الـ Endpoints — نسخ مباشر</span><small>جاهزة للاستخدام حرفيًا</small></div>{ENDPOINT_LINKS.map(link => <div className="endpoint-copy-row" key={link.url}><span className="endpoint-copy-label">{link.label}</span><code dir="ltr">{link.url}</code><button type="button" className="endpoint-copy-btn" onClick={() => copyEndpoint(link.url)}><Copy size={13} /> نسخ</button></div>)}</div>;
  return <div className="admin-content"><div className="admin-section-intro"><div><span className="admin-overline">API GATEWAY</span><h2>مزودو الذكاء</h2><p>المفاتيح تبقى على الخادم، ويمكن قفل النموذج خلف تصريح IP.</p></div><div className="secret-badge"><ShieldCheck size={16} /> server-side</div></div><div className="admin-grid-2"><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">إضافة مزود</span><h3>انشر نموذجًا للزوار</h3></div><KeyRound size={18} /></div><div className="admin-form">{presetSelect}<label>الاسم الظاهر<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="مثال: Cz Pro" /></label><label>نوع المزود<select value={form.kind} onChange={event => { const kind = event.target.value as ProviderKind; setForm({ ...form, kind, model: providerDefaults[kind].model, endpoint: providerDefaults[kind].endpoint }); }}>{Object.keys(providerDefaults).map(kind => <option key={kind} value={kind}>{ADMIN_KIND_LABELS[kind as ProviderKind]}</option>)}</select></label>{form.kind === "czai" ? <label>اسم النموذج<select value={CZ_MODEL_PRESETS.includes(form.model) ? form.model : "__custom"} onChange={event => setForm({ ...form, model: event.target.value === "__custom" ? "" : event.target.value })}>{CZ_MODEL_PRESETS.map(model => <option key={model} value={model}>{model}</option>)}<option value="__custom">خيار آخر…</option></select></label> : <label>اسم النموذج<input dir="ltr" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} placeholder={selectedDefault.model} /></label>}{form.kind === "czai" && !CZ_MODEL_PRESETS.includes(form.model) && <label>اسم النموذج (مخصص)<input dir="ltr" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} placeholder="cz-model-name" /></label>}<label>Endpoint<input dir="ltr" value={form.endpoint} onChange={event => setForm({ ...form, endpoint: event.target.value })} placeholder={selectedDefault.endpoint} /></label><label>مفتاح API السري<input dir="ltr" type="password" value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} placeholder="لن يظهر مرة أخرى" /></label><label className="check-row"><input type="checkbox" checked={form.premium} onChange={event => setForm({ ...form, premium: event.target.checked })} /><span><b>نموذج مدفوع (بفلوس)</b><small>يبقى مقفلًا للزوار حتى يشتريه الزائر وتمنحه له</small></span></label>{form.premium && <label className="price-field">السعر بالدولار (USD)<input type="number" min="0" step="1" value={form.price} onChange={event => setForm({ ...form, price: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} placeholder="25" /><small>اكتب مثلًا 25 — يظهر للزائر بجانب زر الشراء.</small></label>}<label>وصف النموذج<textarea rows={2} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="وصف مختصر يظهر للزائر داخل نافذة الشراء (اختياري)" /></label><label className="check-row"><input type="checkbox" checked={form.supportsAttachments} onChange={event => setForm({ ...form, supportsAttachments: event.target.checked })} /><span><b>تفعيل تحليل المرفقات</b><small>فعّلها فقط لنموذج يدعم الصور والملفات النصية</small></span></label><button className="admin-primary" disabled={add.isPending || !form.name || !form.model || !form.apiKey} onClick={() => add.mutate(form)}>{add.isPending ? "جارٍ الحفظ..." : "حفظ ونشر المزود"}<Plus size={16} /></button><small className="form-security"><ShieldCheck size={13} /> تشفير المفتاح قبل تخزينه</small>{endpointBlock}</div></section><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">PUBLIC MODELS</span><h3>المزودون المنشورون</h3></div><div className="panel-head-tools"><span className="count-chip">{list.data?.length ?? 0}</span>{Boolean(list.data?.length) && <button className="icon-danger with-label" disabled={removeAll.isPending} onClick={() => { if (window.confirm("حذف جميع النماذج المنشورة؟ لا يمكن التراجع.")) removeAll.mutate(); }}><Trash2 size={14} /> حذف الكل</button>}</div></div><div className="admin-provider-list">{list.data?.map(provider => <div className="admin-provider-row" key={provider.id}><div className="admin-provider-logo">{provider.name.slice(0, 1)}</div><div className="admin-provider-copy"><b>{provider.name} {provider.premium ? <span className="premium-badge">{provider.price ? `$${provider.price}` : "PREMIUM"}</span> : <span className="free-badge">مجاني</span>}</b><span>{provider.kind} · {provider.model}</span>{provider.description ? <small className="admin-provider-desc">{provider.description}</small> : null}{provider.publicUntil && new Date(provider.publicUntil).getTime() > Date.now() ? <small className="admin-provider-public"><Globe2 size={11} /> متاح للجميع حتى {formatWhen(provider.publicUntil)}</small> : null}</div>{provider.premium && <input className="row-price" type="number" min="0" step="1" defaultValue={Number(provider.price) || 0} title="السعر بالدولار (USD) — عدّله ثم اضغط خارجه للحفظ" onBlur={event => { const price = Math.max(0, Math.floor(Number(event.target.value) || 0)); if (price !== (Number(provider.price) || 0)) update.mutate({ id: provider.id, name: provider.name, model: provider.model, endpoint: provider.endpoint ?? undefined, premium: true, price, supportsAttachments: Boolean(provider.supportsAttachments) }); }} />}<input className="row-desc" defaultValue={provider.description ?? ""} title="وصف النموذج — عدّله ثم اضغط خارجه للحفظ" placeholder="وصف…" onBlur={event => { const description = event.target.value.trim(); if (description !== (provider.description ?? "")) update.mutate({ id: provider.id, name: provider.name, model: provider.model, endpoint: provider.endpoint ?? undefined, premium: Boolean(provider.premium), price: Number(provider.price) || 0, description, supportsAttachments: Boolean(provider.supportsAttachments) }); }} /><button className={`toggle-button ${provider.enabled ? "on" : ""}`} onClick={() => update.mutate({ id: provider.id, name: provider.name, model: provider.model, endpoint: provider.endpoint ?? undefined, enabled: !Boolean(provider.enabled), premium: Boolean(provider.premium), price: Number(provider.price) || 0, supportsAttachments: Boolean(provider.supportsAttachments) })}><i />{provider.enabled ? "ظاهر" : "مخفي"}</button><button className="icon-danger" onClick={() => { if (window.confirm("حذف هذا المزود من الموقع؟")) remove.mutate({ id: provider.id }); }}><Trash2 size={15} /></button></div>)}</div>{!list.data?.length && <div className="admin-empty"><KeyRound size={23} /><span>أضف مزودًا ليظهر في قائمة النماذج.</span></div>}</section></div></div>;
}

function SiteSettings() {
  const settings = trpc.admin.settings.get.useQuery();
  const update = trpc.admin.settings.update.useMutation({ onSuccess: data => { setForm(data); toast.success("تم حفظ إعدادات الحماية"); }, onError: error => toast.error(error.message) });
  const [form, setForm] = useState(initialSettings);
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  return <div className="admin-content"><div className="admin-section-intro"><div><span className="admin-overline">BRAND · LIMITS · OPERATIONS</span><h2>الإعدادات والتحكم</h2><p>حدد عدد الرسائل، فعّل الصيانة، وأدر بوابة الاشتراك وهوية الموقع.</p></div><div className="telegram-mark"><Wrench size={20} /></div></div><div className="admin-grid-2"><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">GLOBAL QUOTA</span><h3>حصص الرسائل والحماية</h3></div><Gauge size={18} /></div><div className="admin-form"><label>عدد الرسائل المسموح لكل IP يوميًا<input type="number" min="0" max="100000" value={form.dailyMessageLimit} onChange={event => setForm({ ...form, dailyMessageLimit: Number(event.target.value) })} /><small>اكتب 0 لتعطيل الحد. التطبيق يمنع التجاوز من الخادم.</small></label><label className="check-row"><input type="checkbox" checked={form.maintenanceMode} onChange={event => setForm({ ...form, maintenanceMode: event.target.checked })} /><span><b>وضع الصيانة</b><small>يوقف الإرسال مؤقتًا مع إبقاء لوحة الإدارة تعمل</small></span></label><button className="admin-primary" disabled={update.isPending} onClick={() => update.mutate(form)}><Save size={16} /> حفظ الحصة</button></div></section><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">SITE IDENTITY</span><h3>الهوية والاشتراك</h3></div><Globe2 size={18} /></div><div className="admin-form"><label>اسم الموقع<input value={form.siteName} onChange={event => setForm({ ...form, siteName: event.target.value })} /></label><label>الشعار المختصر<input value={form.tagline} onChange={event => setForm({ ...form, tagline: event.target.value })} /></label><label>الوصف<textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} rows={2} /></label><label>حساب تيليجرام<input dir="ltr" value={form.telegramUsername} onChange={event => setForm({ ...form, telegramUsername: event.target.value.replace(/^@/, "") })} /></label><label className="check-row"><input type="checkbox" checked={form.subscriptionRequired} onChange={event => setForm({ ...form, subscriptionRequired: event.target.checked })} /><span><b>اشتراك مطلوب</b><small>يعرض بوابة تيليجرام قبل المحادثة</small></span></label><button className="admin-primary" disabled={update.isPending} onClick={() => update.mutate(form)}><Save size={16} /> حفظ الهوية</button></div></section><section className="admin-panel glass purchase-panel"><div className="admin-panel-head"><div><span className="admin-overline">PURCHASE CONTACT</span><h3>بيانات الشراء</h3></div><MessageSquareText size={18} /></div><div className="admin-form"><label>نص رسالة الشراء<textarea value={form.purchaseMessage} onChange={event => setForm({ ...form, purchaseMessage: event.target.value })} rows={2} placeholder="هل تريد شراء نموذج {model}؟" /><small>استخدم {"{model}"} ليستبدله النظام باسم النموذج تلقائيًا.</small></label><label>رابط واتساب للشراء<input dir="ltr" value={form.purchaseWhatsapp} onChange={event => setForm({ ...form, purchaseWhatsapp: event.target.value })} placeholder="https://wa.me/message/R4J6XXSDMXB6D1" /></label><label>يوزر تيليجرام للشراء<input dir="ltr" value={form.purchaseTelegram} onChange={event => setForm({ ...form, purchaseTelegram: event.target.value.replace(/^@/, "") })} placeholder="c5_xc" /></label><button className="admin-primary" disabled={update.isPending} onClick={() => update.mutate(form)}><Save size={16} /> حفظ بيانات الشراء</button></div></section></div></div>;
}

function AccessRules() {
  const rules = trpc.admin.accessRules.list.useQuery();
  const providers = trpc.admin.providers.list.useQuery();
  const add = trpc.admin.accessRules.add.useMutation({ onSuccess: () => { rules.refetch(); setForm(initialRule); toast.success("تم منح التصريح"); }, onError: error => toast.error(error.message) });
  const remove = trpc.admin.accessRules.delete.useMutation({ onSuccess: () => { rules.refetch(); toast.success("تم إلغاء التصريح"); } });
  const [form, setForm] = useState(initialRule);
  return <div className="admin-content"><div className="admin-section-intro"><div><span className="admin-overline">PREMIUM ACCESS CONTROL</span><h2>تصاريح الوصول</h2><p>افتح كل النماذج المدفوعة أو نموذجًا محددًا لعنوان IP أو لبصمة جهاز (كود الجهاز) مع تاريخ انتهاء اختياري.</p></div><div className="secret-badge"><ShieldCheck size={16} /> تدقيق server-side</div></div><div className="admin-grid-2"><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">GRANT ACCESS</span><h3>منح وصول جديد</h3></div><ShieldCheck size={18} /></div><div className="admin-form"><label>عنوان IP<input dir="ltr" value={form.ip} onChange={event => setForm({ ...form, ip: event.target.value })} placeholder="203.0.113.7" /></label><label>بصمة الجهاز (كود الجهاز — اختياري)<input dir="ltr" value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} placeholder="cz-XXXXXXXX" /></label><label>النطاق<select value={form.allowAllPremium ? "all" : String(form.providerId || "")} onChange={event => setForm({ ...form, allowAllPremium: event.target.value === "all", providerId: event.target.value === "all" ? undefined : Number(event.target.value) })}><option value="">اختر نموذجًا محددًا</option><option value="all">كل النماذج المدفوعة</option>{providers.data?.filter(provider => provider.premium).map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label><label>ينتهي في (اختياري)<input type="datetime-local" value={form.expiresAt} onChange={event => setForm({ ...form, expiresAt: event.target.value })} /></label><label>ملاحظة<input value={form.note} onChange={event => setForm({ ...form, note: event.target.value })} placeholder="اشتراك VIP" /></label><button className="admin-primary" disabled={add.isPending || (!form.ip && !form.code) || (!form.allowAllPremium && !form.providerId)} onClick={() => add.mutate({ ip: form.ip, code: form.code || undefined, providerId: form.allowAllPremium ? undefined : form.providerId, allowAllPremium: form.allowAllPremium, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined, note: form.note })}><Plus size={16} /> منح وصول</button></div></section><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">ACTIVE RULES</span><h3>التصاريح الحالية</h3></div><span className="count-chip">{rules.data?.length ?? 0}</span></div><div className="admin-provider-list">{rules.data?.map(rule => <div className="admin-provider-row" key={rule.id}><div className="admin-provider-logo"><ShieldCheck size={15} /></div><div className="admin-provider-copy"><b dir="ltr">{rule.ip || rule.code || "—"}{rule.ip && rule.code ? ` · بصمة ${rule.code}` : ""}</b><span>{rule.allowAllPremium ? "كل النماذج المدفوعة" : `نموذج رقم ${rule.providerId}`} · {rule.expiresAt ? new Date(rule.expiresAt).toLocaleString("ar-SA") : "بدون انتهاء"}{rule.note ? ` · ${rule.note}` : ""}</span></div><button className="icon-danger" onClick={() => remove.mutate({ id: rule.id })}><Trash2 size={15} /></button></div>)}</div>{!rules.data?.length && <div className="admin-empty"><ShieldCheck size={23} /><span>لا توجد تصاريح. النماذج المدفوعة مغلقة للجميع.</span></div>}</section></div></div>;
}
const initialRule = { ip: "", code: "", providerId: undefined as number | undefined, allowAllPremium: true, expiresAt: "", note: "" };

function Visitors() {
  const visitors = trpc.admin.visitors.list.useQuery();
  const setBlocked = trpc.admin.visitors.setBlocked.useMutation({ onSuccess: () => { visitors.refetch(); toast.success("تم تحديث حالة العنوان"); } });
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => (visitors.data ?? []).filter(row => row.ip.includes(filter)), [visitors.data, filter]);
  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">TRAFFIC &amp; SECURITY</span><h2>الزوار والحماية</h2><p>راقب IP والطلبات والرسائل المستهلكة واحظر أي عنوان.</p></div><div className="privacy-note"><ShieldCheck size={15} /> حماية وخصوصية</div></div>
      <section className="admin-panel glass visitors-panel">
        <div className="admin-panel-head"><div><span className="admin-overline">RECENT VISITORS</span><h3>آخر العناوين</h3></div><div className="visitor-tools"><label><Users size={14} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="بحث بالـ IP" /></label><button onClick={() => visitors.refetch()}><RefreshCw size={14} /></button></div></div>
        <div className="visitor-table">
          <div className="visitor-head"><span>العنوان</span><span>آخر نشاط</span><span>الطلبات</span><span>رسائل اليوم</span><span>الحالة</span><span>إجراء</span></div>
          {rows.map(row => <div className="visitor-row visitor-row-six" key={row.ip}><code>{row.ip}</code><span>{new Date(row.lastSeen).toLocaleString("ar-SA")}</span><span>{row.requestCount}</span><span>{row.messageCount}</span><span className={row.blocked ? "state-pill danger" : "state-pill ready"}>{row.blocked ? "محظور" : "نشط"}</span><button className={row.blocked ? "unblock-button" : "block-button"} onClick={() => setBlocked.mutate({ ip: row.ip, blocked: !Boolean(row.blocked) })}>{row.blocked ? <><Check size={14} /> إلغاء</> : <><Ban size={14} /> حظر</>}</button></div>)}
          {!rows.length && <div className="admin-empty"><Users size={23} /><span>لا توجد عناوين مسجلة بعد.</span></div>}
        </div>
      </section>
      <div className="privacy-banner"><ShieldCheck size={17} /><span><b>ملاحظة:</b> يتم تسجيل IP لأنك طلبت التحكم والحظر. أضف ذلك إلى سياسة الخصوصية قبل الإطلاق.</span></div>
    </div>
  );
}

function Audit() {
  const logs = trpc.admin.audit.list.useQuery();
  return <div className="admin-content"><div className="admin-section-intro"><div><span className="admin-overline">AUDIT TRAIL</span><h2>سجل التدقيق</h2><p>كل تغيير إداري مهم يظهر هنا مع الهدف والتوقيت.</p></div><div className="secret-badge"><FileSearch size={16} /> غير قابل للعرض العام</div></div><section className="admin-panel glass"><div className="admin-panel-head"><div><span className="admin-overline">RECENT EVENTS</span><h3>الأحداث الإدارية</h3></div><button onClick={() => logs.refetch()}><RefreshCw size={15} /> تحديث</button></div><div className="audit-list">{logs.data?.map(log => <div className="audit-row" key={log.id}><span className="audit-icon"><FileSearch size={14} /></span><span><b>{log.action}</b><small>{log.target || "—"} {log.ip ? `· ${log.ip}` : ""}</small></span><time>{new Date(log.createdAt).toLocaleString("ar-SA")}</time></div>)}{!logs.data?.length && <div className="admin-empty"><FileSearch size={23} /><span>لا توجد عمليات مسجلة بعد.</span></div>}</div></section></div>;
}

/* ===== Devices / code, Agent grants, bans, and saved chats ===== */

function parseAssignedClient(raw?: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(value => Number.isInteger(value) && value > 0) : [];
  } catch {
    return [];
  }
}

type ClientGrant = { expiresAt: number | null; at: number; paused?: boolean };

function parseGrantsClient(raw?: string | null): Record<string, ClientGrant> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ClientGrant> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      const grant = (value ?? {}) as { expiresAt?: unknown; at?: unknown; paused?: unknown };
      const expiry = grant.expiresAt == null ? null : Number(grant.expiresAt);
      out[String(id)] = { expiresAt: expiry != null && Number.isFinite(expiry) ? expiry : null, at: Number(grant.at) || Date.now(), ...(grant.paused ? { paused: true } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

function parseRevokesClient(raw?: string | null): Record<string, { at: number }> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, { at: number }> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      out[String(id)] = { at: Number((value as { at?: unknown })?.at) || Date.now() };
    }
    return out;
  } catch {
    return {};
  }
}

function grantActive(grant: ClientGrant | undefined, now = Date.now()) {
  if (!grant) return false;
  if (grant.paused) return false;
  return grant.expiresAt == null || grant.expiresAt > now;
}

/** True when a grant exists, has not expired, and is temporarily paused. */
function grantPaused(grant: ClientGrant | undefined, now = Date.now()) {
  if (!grant) return false;
  if (grant.paused !== true) return false;
  return grant.expiresAt == null || grant.expiresAt > now;
}

/** Durations the admin can pick when granting a model or Agent access. */
const GRANT_DURATIONS: Array<{ id: string; label: string; ms: number | null }> = [
  { id: "5m", label: "5 دقائق", ms: 5 * 60 * 1000 },
  { id: "10m", label: "10 دقائق", ms: 10 * 60 * 1000 },
  { id: "30m", label: "30 دقيقة", ms: 30 * 60 * 1000 },
  { id: "1h", label: "1 ساعة", ms: 60 * 60 * 1000 },
  { id: "1d", label: "1 يوم", ms: 86400000 },
  { id: "7d", label: "7 أيام", ms: 7 * 86400000 },
  { id: "30d", label: "30 يوم", ms: 30 * 86400000 },
  { id: "1y", label: "سنة", ms: 365 * 86400000 },
  { id: "life", label: "مدى الحياه", ms: null },
];

function durationMs(id: string): number | null {
  return GRANT_DURATIONS.find(item => item.id === id)?.ms ?? null;
}

function isActiveFlag(enabled: unknown, expiresAt?: string | Date | null) {
  if (!enabled) return false;
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > Date.now();
}

function formatWhen(value: string | Date | null | undefined) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-SA");
  } catch {
    return "—";
  }
}

function Devices() {
  const query = trpc.admin.devices.list.useQuery();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState("");
  const [submittedFilter, setSubmittedFilter] = useState("");
  const [durations, setDurations] = useState<Record<string, string>>({});
  const [grantDurations, setGrantDurations] = useState<Record<string, string>>({});
  const setBan = trpc.admin.devices.setBan.useMutation({ onSuccess: (_data, variables) => { query.refetch(); utils.site.getConfig.invalidate(); toast.success(variables.banned ? "تم تحديث الحظر" : "تم إلغاء الحظر"); }, onError: error => toast.error(error.message) });
  const setAgent = trpc.admin.devices.setAgent.useMutation({ onSuccess: (_data, variables) => { query.refetch(); utils.site.getConfig.invalidate(); toast.success(variables.enabled ? "تم تفعيل ميزة Agent" : "تم إلغاء تفعيل Agent"); }, onError: error => toast.error(error.message) });
  const grant = trpc.admin.devices.grant.useMutation({ onSuccess: () => { query.refetch(); utils.site.getConfig.invalidate(); toast.success("تم منح النموذج للجهاز"); }, onError: error => toast.error(error.message) });
  const ungrant = trpc.admin.devices.ungrant.useMutation({ onSuccess: () => { query.refetch(); utils.site.getConfig.invalidate(); toast.success("تم إزالة النموذج الممنوح"); }, onError: error => toast.error(error.message) });
  const revoke = trpc.admin.devices.revoke.useMutation({ onSuccess: (_data, variables) => { query.refetch(); utils.site.getConfig.invalidate(); toast.success(variables.revoked ? "تم إلغاء النموذج (الغيه)" : "تمت استعادة النموذج"); }, onError: error => toast.error(error.message) });

  const providers = query.data?.providers ?? [];
  const reported = query.data?.reportedProviders ?? [];
  const reportedFor = (code: string) => reported.filter(item => item.code === code);
  const accessRules = query.data?.accessRules ?? [];
  const ipRulesFor = (ip?: string | null) => (ip ? accessRules.filter(rule => rule.ip === ip) : []);
  const devices = useMemo(() => (query.data?.devices ?? []).filter(device => {
    const needle = submittedFilter.trim();
    if (!needle) return true;
    return (device.code ?? "").includes(needle) || (device.ip ?? "").includes(needle) || (device.city ?? "").includes(needle) || (device.country ?? "").includes(needle) || (device.latitude ?? "").includes(needle) || (device.longitude ?? "").includes(needle);
  }), [query.data, submittedFilter]);

  const expiryFromDuration = (value: string) => {
    const ms = durationMs(value);
    return ms == null ? undefined : new Date(Date.now() + ms).toISOString();
  };
  const expiryFor = (code: string) => expiryFromDuration(durations[code] ?? "30m");
  const grantExpiryFor = (code: string) => expiryFromDuration(grantDurations[code] ?? "30d");

  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">DEVICES · AGENT · BANS</span><h2>الأجهزة والتفعيل</h2><p>كل جهاز له كود ثابت يظهر له أعلى اليمين. فعّل له Agent بمدة محددة أو مدى الحياة، امنحه نماذج جاهزة بمفتاحك، أو احظره مؤقتًا/دائمًا.</p></div><div className="secret-badge"><Fingerprint size={16} /> كود ثابت لكل جهاز</div></div>
      <section className="admin-panel glass visitors-panel">
        <div className="admin-panel-head"><div><span className="admin-overline">REGISTERED DEVICES</span><h3>آخر الأجهزة</h3></div><div className="visitor-tools"><label><Fingerprint size={14} /><input value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Enter") setSubmittedFilter(filter.trim()); }} placeholder="بحث بالكود أو IP أو المدينة" /></label><button onClick={() => setSubmittedFilter(filter.trim())}><Search size={14} /> بحث</button><button onClick={() => query.refetch()}><RefreshCw size={14} /></button>{submittedFilter.trim() && <button className="clear-search" onClick={() => { setFilter(""); setSubmittedFilter(""); }}><X size={13} /> مسح</button>}</div></div>
        <div className="device-list">
          {devices.map(device => {
            const agentActive = isActiveFlag(device.agentEnabled, device.agentExpiresAt);
            const banActive = isActiveFlag(device.banned, device.banExpiresAt);
            const grants = parseGrantsClient(device.providerGrants);
            const revokes = parseRevokesClient(device.providerRevokes);
            const activeIds = new Set<number>(parseAssignedClient(device.assignedProviders));
            for (const key of Object.keys(grants)) if (grantActive(grants[key])) activeIds.add(Number(key));
            for (const key of Object.keys(revokes)) activeIds.delete(Number(key));
            return (
              <div className="device-row" key={device.code}>
                <div className="device-row-head">
                  <span className="device-code"><Fingerprint size={13} /> {device.code}</span>
                  <span className="device-meta"><Globe2 size={13} /> {device.ip ?? "—"}</span>
                  <span className="device-meta"><MapPin size={13} /> {device.latitude && device.longitude ? <a className="coord-link" href={`https://www.google.com/maps?q=${encodeURIComponent(`${device.latitude},${device.longitude}`)}`} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}><span dir="ltr">{device.latitude}, {device.longitude}</span><ExternalLink size={11} /></a> : [device.city, device.region, device.country].filter(Boolean).join(" · ") || "موقع غير معروف"}</span>
                  <span className="device-meta"><Timer size={13} /> {formatWhen(device.lastSeen)}</span>
                  <span className="device-meta"><MessageSquareText size={13} /> {device.messageCount} رسالة</span>
                  {banActive && <span className="state-pill danger">محظور {device.banExpiresAt ? `حتى ${formatWhen(device.banExpiresAt)}` : "دائمًا"}</span>}
                  {agentActive && <span className="state-pill ready">Agent {device.agentExpiresAt ? `حتى ${formatWhen(device.agentExpiresAt)}` : "مدى الحياة"}</span>}
                </div>
                <div className="device-controls">
                  <div className="device-control">
                    <span className="device-control-label"><Wrench size={13} /> ميزة Agent</span>
                    <select value={durations[device.code] ?? "30m"} onChange={event => setDurations(prev => ({ ...prev, [device.code]: event.target.value }))}>{GRANT_DURATIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
                    <button className="admin-primary small" disabled={setAgent.isPending} onClick={() => setAgent.mutate({ code: device.code, enabled: true, expiresAt: expiryFor(device.code) })}>تفعيل</button>
                    <button className="unblock-button" disabled={setAgent.isPending} onClick={() => setAgent.mutate({ code: device.code, enabled: false })}>إلغاء</button>
                  </div>
                  <div className="device-control">
                    <span className="device-control-label"><Ban size={13} /> الحظر</span>
                    <button className="block-button" disabled={setBan.isPending} onClick={() => setBan.mutate({ code: device.code, banned: true, reason: "حظر دائم من لوحة الإدارة" })}>دائم</button>
                    <button className="block-button" disabled={setBan.isPending} onClick={() => setBan.mutate({ code: device.code, banned: true, expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: "حظر 24 ساعة" })}>24 ساعة</button>
                    <button className="block-button" disabled={setBan.isPending} onClick={() => setBan.mutate({ code: device.code, banned: true, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), reason: "حظر 7 أيام" })}>7 أيام</button>
                    <button className="unblock-button" disabled={setBan.isPending} onClick={() => setBan.mutate({ code: device.code, banned: false })}>إلغاء</button>
                  </div>
                  <div className="device-control wide">
                    <span className="device-control-label"><Bot size={13} /> النماذج الممنوحة لهذا الجهاز</span>
                    <div className="device-grant-bar">
                      <select value={grantDurations[device.code] ?? "30d"} onChange={event => setGrantDurations(prev => ({ ...prev, [device.code]: event.target.value }))}>{GRANT_DURATIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
                      <small className="device-hint">اختر المدة ثم اضغط النموذج لمنحه. زر «الغيه» يمنعه حتى لو كان متاحًا لعنوان IP.</small>
                    </div>
                    <div className="device-chips">
                      {providers.length === 0 && <small className="device-hint">أضف مزودًا أولًا من تبويب «مزودو الذكاء».</small>}
                      {providers.map(provider => {
                        const key = String(provider.id);
                        const active = activeIds.has(provider.id);
                        const revoked = Boolean(revokes[key]);
                        const grantEntry = grants[key];
                        return (
                          <div className="provider-chip-group" key={provider.id}>
                            <button className={`provider-chip ${active ? "on" : ""} ${revoked ? "revoked" : ""}`} disabled={revoked || grant.isPending || ungrant.isPending} onClick={() => (active ? ungrant.mutate({ code: device.code, providerId: provider.id }) : grant.mutate({ code: device.code, providerId: provider.id, expiresAt: grantExpiryFor(device.code) }))}>{active ? <Check size={12} /> : <Plus size={12} />} {provider.name}{provider.premium ? " · مدفوع" : ""}</button>
                            {active && <small className="grant-expiry">{grantEntry?.expiresAt ? `حتى ${formatWhen(new Date(grantEntry.expiresAt))}` : "مدى الحياه"}</small>}
                            <button className={`revoke-btn ${revoked ? "on" : ""}`} disabled={revoke.isPending} title={revoked ? "استعادة النموذج" : "الغاء النموذج لهذا الجهاز"} onClick={() => revoke.mutate({ code: device.code, providerId: provider.id, revoked: !revoked })}>{revoked ? "استعادة" : "الغيه"}</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {activeIds.size > 0 && <div className="device-control wide"><span className="device-control-label"><Check size={13} /> الممنوحة حاليًا</span><div className="reported-list">{providers.filter(provider => activeIds.has(provider.id)).map(provider => { const grantEntry = grants[String(provider.id)]; return <span className="reported-chip granted" key={provider.id}><b>{provider.name}</b><small>{grantEntry?.expiresAt ? `حتى ${formatWhen(new Date(grantEntry.expiresAt))}` : "مدى الحياه"}</small></span>; })}</div></div>}
                  {Object.keys(revokes).length > 0 && <div className="device-control wide"><span className="device-control-label"><Ban size={13} /> الإلغاءات (الغيه)</span><div className="reported-list">{Object.keys(revokes).map(key => { const provider = providers.find(item => String(item.id) === key); return <span className="reported-chip revoked" key={key}><b>{provider?.name ?? `نموذج #${key}`}</b><small>ملغى</small></span>; })}</div></div>}
                  {ipRulesFor(device.ip).length > 0 && <div className="device-control wide"><span className="device-control-label"><ShieldCheck size={13} /> تصاريح IP لهذا العنوان</span><div className="reported-list">{ipRulesFor(device.ip).map(rule => { const provider = rule.providerId ? providers.find(item => item.id === rule.providerId) : null; return <span className="reported-chip" key={rule.id}><b>{rule.allowAllPremium ? "كل النماذج المدفوعة" : provider?.name ?? `نموذج #${rule.providerId}`}</b><small>{rule.expiresAt ? `حتى ${formatWhen(rule.expiresAt)}` : "مدى الحياه"}</small></span>; })}</div></div>}
                  {reportedFor(device.code).length > 0 && <div className="device-control wide"><span className="device-control-label"><KeyRound size={13} /> نماذج أضافها الزائر بنفسه</span><div className="reported-list">{reportedFor(device.code).map((item, index) => <span className="reported-chip" key={`${device.code}-${index}`}><b>{item.name}</b><small>{item.kind} · {item.model}</small></span>)}</div></div>}
                </div>
              </div>
            );
          })}
          {!devices.length && <div className="admin-empty"><Fingerprint size={23} /><span>لا توجد أجهزة مسجلة بعد. سيظهر كل زائر هنا تلقائيًا بمجرد دخوله للموقع.</span></div>}
        </div>
      </section>
    </div>
  );
}

function fmtDate(value: Date | string | number) {
  try {
    return new Intl.DateTimeFormat("ar-SA", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "";
  }
}

function MailCenter() {
  const list = trpc.admin.mail.list.useQuery(undefined, { refetchInterval: 8000 });
  const devices = trpc.admin.devices.list.useQuery();
  const send = trpc.admin.mail.send.useMutation({ onSuccess: () => { list.refetch(); setForm({ target: "all", title: "", body: "" }); toast.success("تم إرسال الرسالة"); }, onError: error => toast.error(error.message) });
  const remove = trpc.admin.mail.delete.useMutation({ onSuccess: () => { list.refetch(); toast.success("تم حذف الرسالة"); }, onError: error => toast.error(error.message) });
  const [form, setForm] = useState({ target: "all", title: "", body: "" });
  const codes = devices.data?.devices ?? [];
  const messages = list.data ?? [];
  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">MAIL · BROADCAST</span><h2>البريد</h2><p>أرسل رسالة تظهر داخل الموقع لكل الزوار معًا، أو لجهاز واحد بكوده. الزائر يقرأ فقط ولا يستطيع الرد.</p></div><div className="secret-badge"><Mail size={16} /> قراءة فقط للزوار</div></div>
      <div className="admin-grid-2">
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">COMPOSE</span><h3>رسالة جديدة</h3></div><Send size={18} /></div>
          <div className="admin-form">
            <label>الجهة<select value={form.target} onChange={event => setForm({ ...form, target: event.target.value })}><option value="all">📢 الجميع (بث عام)</option>{codes.map(device => <option key={device.code} value={device.code}>{device.code}{device.city ? ` · ${device.city}` : ""}</option>)}</select></label>
            <label>العنوان<input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="عنوان مختصر" /></label>
            <label>النص<textarea rows={5} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} placeholder="اكتب رسالتك هنا..." /></label>
            <button className="admin-primary" disabled={send.isPending || !form.body.trim()} onClick={() => send.mutate({ target: form.target, title: form.title.trim() || undefined, body: form.body.trim() })}><Send size={16} /> {send.isPending ? "جارٍ الإرسال..." : "إرسال الرسالة"}</button>
          </div>
        </section>
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">SENT</span><h3>الرسائل المرسلة <b>{messages.length}</b></h3></div><button onClick={() => list.refetch()}><RefreshCw size={14} /></button></div>
          {messages.length === 0 ? <div className="admin-empty"><MailOpen size={23} /><span>لا توجد رسائل بعد.</span></div> : <div className="mail-admin-list">{messages.map(message => <div className="mail-admin-row" key={message.id}><div className="mail-admin-main"><b>{message.title}</b><small>{message.target === "all" ? "📢 الجميع" : message.target} · {fmtDate(message.createdAt)} · قرأها {message.readCount}</small><p>{message.body}</p></div><button className="admin-icon-danger" onClick={() => remove.mutate({ id: message.id })} title="حذف"><Trash2 size={15} /></button></div>)}</div>}
        </section>
      </div>
    </div>
  );
}

function SupportCenter() {
  const threads = trpc.admin.support.list.useQuery(undefined, { refetchInterval: 5000 });
  const [selected, setSelected] = useState<string | null>(null);
  const thread = trpc.admin.support.thread.useQuery({ code: selected ?? "" }, { enabled: Boolean(selected), refetchInterval: selected ? 3000 : false });
  const reply = trpc.admin.support.reply.useMutation({ onSuccess: () => { thread.refetch(); threads.refetch(); setDraft(""); }, onError: error => toast.error(error.message) });
  const remove = trpc.admin.support.delete.useMutation({ onSuccess: () => { threads.refetch(); setSelected(null); toast.success("تم حذف المحادثة"); }, onError: error => toast.error(error.message) });
  const [draft, setDraft] = useState("");
  const [detailsCode, setDetailsCode] = useState<string | null>(null);
  const rows = threads.data ?? [];
  const sendReply = () => { if (draft.trim() && selected) reply.mutate({ code: selected, body: draft.trim() }); };
  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">LIVE SUPPORT</span><h2>الدعم الفني</h2><p>محادثات مباشرة مع الزوار. ينبّهك الموقع بصوت وشارة عند وصول رسالة جديدة، ويمكنك الرد فورًا من هنا.</p></div><div className="secret-badge"><Headset size={16} /> دردشة مباشرة</div></div>
      <div className="support-admin">
        <section className="admin-panel glass support-thread-list">
          <div className="admin-panel-head"><div><span className="admin-overline">THREADS</span><h3>المحادثات <b>{rows.length}</b></h3></div><button onClick={() => threads.refetch()}><RefreshCw size={14} /></button></div>
          {rows.length === 0 ? <div className="admin-empty"><Headset size={23} /><span>لا توجد محادثات بعد.</span></div> : <div className="support-thread-items">{rows.map(row => <div className={`support-thread-item ${selected === row.code ? "active" : ""}`} key={row.id}><button className="support-thread-select" onClick={() => setSelected(row.code)}><div className="support-thread-avatar"><Headset size={15} /></div><div className="support-thread-info"><b>{row.code}</b><small>{row.lastSender === "admin" ? "أنت: " : ""}{row.lastMessage || "—"}</small><span>{row.ip || ""}{row.lastMessageAt ? ` · ${fmtDate(row.lastMessageAt)}` : ""}</span></div>{row.unreadForAdmin > 0 && <em className="admin-nav-badge">{row.unreadForAdmin > 99 ? "99+" : row.unreadForAdmin}</em>}</button><button className="support-thread-eye" title="عرض كل تفاصيل هذا الجهاز" aria-label="تفاصيل الجهاز" onClick={() => setDetailsCode(row.code)}><Eye size={15} /></button></div>)}</div>}
        </section>
        <section className="admin-panel glass support-conversation">
          {!selected ? <div className="admin-empty"><MessageSquareText size={23} /><span>اختر محادثة من القائمة لعرضها.</span></div> : <>
            <div className="admin-panel-head"><div><span className="admin-overline">CONVERSATION</span><h3>{selected}</h3></div><button className="admin-icon-danger" onClick={() => { if (thread.data?.id) remove.mutate({ id: thread.data.id }); }} title="حذف المحادثة"><Trash2 size={15} /></button></div>
            <div className="support-conversation-body">
              {(thread.data?.messages ?? []).map(message => <div className={`support-cmsg ${message.sender}`} key={message.id}><div className="support-bubble">{message.body}</div><small>{message.sender === "admin" ? "أنت" : selected} · {fmtDate(message.createdAt)}</small></div>)}
              {!(thread.data?.messages ?? []).length && <div className="admin-empty"><MessageSquareText size={20} /><span>لا توجد رسائل بعد.</span></div>}
            </div>
            <div className="support-composer">
              <textarea rows={2} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendReply(); } }} placeholder="اكتب ردك للزائر..." />
              <button className="admin-primary" disabled={!draft.trim() || reply.isPending} onClick={sendReply}><Send size={15} /> إرسال</button>
            </div>
          </>}
        </section>
      </div>
      {detailsCode && <DeviceDetailsDrawer code={detailsCode} onClose={() => setDetailsCode(null)} />}
    </div>
  );
}

/* ===== الاشتراكات: منح نماذج لشخص واحد (بالبصمة) أو للجميع بمدة محددة ===== */

function Subscriptions() {
  const devicesQuery = trpc.admin.devices.list.useQuery();
  const providersQuery = trpc.admin.providers.list.useQuery();
  const utils = trpc.useUtils();
  const grant = trpc.admin.devices.grant.useMutation();
  const ungrant = trpc.admin.devices.ungrant.useMutation();
  const setPublic = trpc.admin.providers.setPublic.useMutation();
  const renew = trpc.admin.devices.renew.useMutation();
  const revoke = trpc.admin.devices.revoke.useMutation();
  const pause = trpc.admin.devices.pause.useMutation();
  const [target, setTarget] = useState<"person" | "all">("person");
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [duration, setDuration] = useState("30d");
  const [busy, setBusy] = useState(false);

  const devices = devicesQuery.data?.devices ?? [];
  const providers = providersQuery.data ?? [];
  const usage = devicesQuery.data?.usage ?? [];
  const reported = devicesQuery.data?.reportedProviders ?? [];
  const refresh = () => { devicesQuery.refetch(); providersQuery.refetch(); void utils.site.getConfig.invalidate(); };

  // ---- Per-person panel: every model appears as مفتوح (granted) or مقفل. ----
  const personCode = code.trim();
  const personDevice = devices.find(device => device.code === personCode) ?? null;
  const personGrants = parseGrantsClient(personDevice?.providerGrants);
  const personRevokes = parseRevokesClient(personDevice?.providerRevokes);
  const personUsage = usage.filter(row => row.code === personCode);
  const personReported = reported.filter(item => item.code === personCode);
  const personTotals = personUsage.reduce((acc, row) => ({ prompt: acc.prompt + row.promptTokens, completion: acc.completion + row.completionTokens, messages: acc.messages + row.messages }), { prompt: 0, completion: 0, messages: 0 });
  const usageFor = (providerId: number) => personUsage.find(row => row.providerId === providerId);
  const usageOf = (deviceCode: string, providerId: number) => usage.find(row => row.code === deviceCode && row.providerId === providerId);
  const tokenTotal = (row?: { promptTokens: number; completionTokens: number }) => (row ? row.promptTokens + row.completionTokens : 0);
  const openCount = providers.filter(provider => grantActive(personGrants[String(provider.id)])).length;
  const pausedCount = providers.filter(provider => grantPaused(personGrants[String(provider.id)])).length;
  const durationLabel = GRANT_DURATIONS.find(option => option.id === duration)?.label ?? duration;

  const grantOne = (providerId: number) => {
    const ms = durationMs(duration);
    grant.mutate({ code: personCode, providerId, expiresAt: ms == null ? undefined : new Date(Date.now() + ms).toISOString() }, { onSuccess: () => { refresh(); toast.success("تم تفعيل النموذج لهذا الشخص"); }, onError: error => toast.error(error.message) });
  };
  const renewOne = (providerId: number) => renew.mutate({ code: personCode, providerId, ms: durationMs(duration) }, { onSuccess: () => { refresh(); toast.success("تم تجديد مدة الاشتراك"); }, onError: error => toast.error(error.message) });
  const revokeOne = (providerId: number, revoked: boolean) => revoke.mutate({ code: personCode, providerId, revoked }, { onSuccess: () => { refresh(); toast.success(revoked ? "تم إيقاف النموذج نهائيًا لهذا الشخص" : "تمت استعادة النموذج"); }, onError: error => toast.error(error.message) });
  const pauseOne = (providerId: number, paused: boolean) => pause.mutate({ code: personCode, providerId, paused }, { onSuccess: () => { refresh(); toast.success(paused ? "تم إيقاف النموذج مؤقتًا (يمكنك فتحه لاحقًا)" : "تم فتح النموذج من جديد"); }, onError: error => toast.error(error.message) });
  const personStateFor = (provider: { id: number; premium: number | boolean }) => {
    if (personRevokes[String(provider.id)]) return { key: "revoked" as const, label: "ملغى نهائيًا" };
    if (grantPaused(personGrants[String(provider.id)])) return { key: "paused" as const, label: "موقوف مؤقتًا" };
    if (grantActive(personGrants[String(provider.id)])) return { key: "open" as const, label: "مفتوح" };
    if (!provider.premium) return { key: "free" as const, label: "متاح للجميع" };
    return { key: "locked" as const, label: "مقفل" };
  };

  const toggleProvider = (id: number) => setSelected(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));

  const apply = async () => {
    if (!selected.length) { toast.error("اختر نموذجًا واحدًا على الأقل"); return; }
    if (target === "person" && !code.trim()) { toast.error("أدخل بصمة الجهاز (الكود)"); return; }
    const ms = durationMs(duration);
    const expiresAt = ms == null ? undefined : new Date(Date.now() + ms).toISOString();
    setBusy(true);
    try {
      if (target === "all") {
        for (const id of selected) {
          if (ms == null) await setPublic.mutateAsync({ id, permanent: true });
          else await setPublic.mutateAsync({ id, publicUntil: expiresAt });
        }
        toast.success("تم تفعيل النماذج للجميع");
      } else {
        for (const id of selected) await grant.mutateAsync({ code: code.trim(), providerId: id, expiresAt });
        toast.success("تم تفعيل النماذج لهذا الجهاز فقط");
      }
      setSelected([]);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذّر إتمام الاشتراك");
    } finally {
      setBusy(false);
    }
  };

  const grantRows: Array<{ code: string; providerId: number; name: string; expiresAt: number | null; paused: boolean }> = [];
  for (const device of devices) {
    const grants = parseGrantsClient(device.providerGrants);
    for (const [key, value] of Object.entries(grants)) {
      const active = grantActive(value);
      const isPaused = grantPaused(value);
      if (!active && !isPaused) continue;
      grantRows.push({ code: device.code, providerId: Number(key), name: providers.find(item => item.id === Number(key))?.name ?? `نموذج #${key}`, expiresAt: value.expiresAt, paused: isPaused });
    }
  }
  const publicRows = providers.filter(provider => provider.publicUntil && new Date(provider.publicUntil).getTime() > Date.now());

  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">SUBSCRIPTIONS</span><h2>الاشتراكات</h2><p>فعّل نموذجًا (أو عدة) لشخص واحد ببصمته فقط، أو للجميع، واختر المدة (5 دقائق، 7 أيام، 30 يوم، سنة، مدى الحياه…). وتحت كل شخص تظهر كل النماذج: المفتوح والمقفل، مع التوكنز وحدّ النموذج ورابطه، وأزرار «إيقاف مؤقت» و«فتح» و«إيقاف نهائي».</p></div><div className="secret-badge"><CreditCard size={16} /> تحكّم كامل</div></div>
      <div className="admin-grid-2">
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">NEW SUBSCRIPTION</span><h3>منح اشتراك</h3></div><CreditCard size={18} /></div>
          <div className="admin-form">
            <div className="subs-target">
              <button className={target === "person" ? "active" : ""} onClick={() => setTarget("person")}><Fingerprint size={14} /> لشخص واحد (بالبصمة)</button>
              <button className={target === "all" ? "active" : ""} onClick={() => setTarget("all")}><Globe2 size={14} /> للجميع</button>
            </div>
            {target === "person" && <label>بصمة الجهاز (كود الجهاز)<input dir="ltr" list="subs-devices" value={code} onChange={event => setCode(event.target.value)} placeholder="cz-XXXXXXXX" /><datalist id="subs-devices">{devices.map(device => <option key={device.code} value={device.code}>{device.city ?? device.ip ?? ""}</option>)}</datalist></label>}
            <div className="subs-block"><span className="device-control-label"><KeyRound size={13} /> النماذج</span><div className="device-chips">{providers.length === 0 ? <small className="device-hint">أضف مزودًا أولًا من تبويب «مزودو الذكاء».</small> : providers.map(provider => <button key={provider.id} className={`provider-chip ${selected.includes(provider.id) ? "on" : ""}`} onClick={() => toggleProvider(provider.id)}>{selected.includes(provider.id) ? <Check size={12} /> : <Plus size={12} />} {provider.name}{provider.premium ? " · مدفوع" : ""}</button>)}</div></div>
            <div className="subs-block"><span className="device-control-label"><Timer size={13} /> المدة</span><div className="device-chips">{GRANT_DURATIONS.map(option => <button key={option.id} className={`provider-chip ${duration === option.id ? "on" : ""}`} onClick={() => setDuration(option.id)}>{option.label}</button>)}</div></div>
            <button className="admin-primary" disabled={busy || !selected.length || (target === "person" && !code.trim())} onClick={apply}><Check size={16} /> {busy ? "جارٍ التفعيل..." : "تفعيل الاشتراك"}</button>
            <small className="form-security"><ShieldCheck size={13} /> التفعيل مربوط بالجهاز أو بالجميع فقط، ولا يُخزَّن أي مفتاح هنا.</small>
          </div>
        </section>
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">ACTIVE</span><h3>الاشتراكات الحالية <b>{grantRows.length + publicRows.length}</b></h3></div><button onClick={refresh}><RefreshCw size={14} /></button></div>
          {grantRows.length === 0 && publicRows.length === 0 ? <div className="admin-empty"><CreditCard size={23} /><span>لا توجد اشتراكات فعالة بعد.</span></div> : <div className="subs-list">
            {publicRows.map(provider => <div className="subs-row" key={`pub-${provider.id}`}><span className="subs-row-icon"><Globe2 size={15} /></span><div><b>{provider.name} · الجميع</b><small>{provider.publicUntil ? `حتى ${formatWhen(provider.publicUntil)}` : "دائم"}</small></div><button className="admin-icon-danger" title="إلغاء" onClick={() => setPublic.mutate({ id: provider.id, publicUntil: null }, { onSuccess: () => { refresh(); toast.success("تم إلغاء الاشتراك العام"); } })}><Trash2 size={15} /></button></div>)}
            {grantRows.map(row => { const used = usageOf(row.code, row.providerId); return <div className="subs-row" key={`${row.code}-${row.providerId}`}><span className="subs-row-icon"><Fingerprint size={15} /></span><div><b>{row.name}{row.paused ? <i className="subs-tag paused">موقوف</i> : null}</b><small>{row.code} · {row.expiresAt ? `حتى ${formatWhen(new Date(row.expiresAt))}` : "مدى الحياه"} · {tokenTotal(used).toLocaleString("ar-SA")} توكن</small></div><button className="admin-icon-danger" title="إلغاء" onClick={() => ungrant.mutate({ code: row.code, providerId: row.providerId }, { onSuccess: () => { refresh(); toast.success("تم إلغاء الاشتراك"); } })}><Trash2 size={15} /></button></div>; })}
          </div>}
        </section>
      </div>
      {target === "person" && (
        <section className="admin-panel glass subs-person">
          <div className="admin-panel-head">
            <div><span className="admin-overline">PERSON · LOCKED / OPEN</span><h3>لوحة الشخص {personCode ? <b dir="ltr">{personCode}</b> : <b>—</b>}</h3></div>
            <div className="subs-person-tools">
              <select value={duration} onChange={event => setDuration(event.target.value)} title="المدة المستخدمة عند الإضافة أو التجديد">{GRANT_DURATIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              <button onClick={refresh}><RefreshCw size={14} /></button>
            </div>
          </div>
          {!personCode ? (
            <div className="admin-empty"><Fingerprint size={23} /><span>اكتب بصمة الجهاز (الكود) في الأعلى لتظهر هنا كل النماذج: الممنوح «مفتوح» وغيره «مقفل».</span></div>
          ) : !personDevice ? (
            <div className="admin-empty"><Fingerprint size={23} /><span>لا يوجد جهاز بهذه البصمة بعد. تأكد من الكود (مثال: cz-XXXXXXXX).</span></div>
          ) : (
            <>
              <div className="subs-person-summary">
                <span className="state-pill ready"><Check size={12} /> {openCount} نموذج مفتوح</span>
                {pausedCount > 0 && <span className="state-pill paused-pill"><Pause size={12} /> {pausedCount} موقوف مؤقتًا</span>}
                <span className="state-pill"><Gauge size={12} /> {personTotals.messages.toLocaleString("ar-SA")} رسالة</span>
                <span className="state-pill"><Gauge size={12} /> {(personTotals.prompt + personTotals.completion).toLocaleString("ar-SA")} توكن (مدخل {(personTotals.prompt).toLocaleString("ar-SA")} · مخرج {(personTotals.completion).toLocaleString("ar-SA")})</span>
                <span className="state-pill"><Globe2 size={12} /> {personDevice.ip ?? "—"}{personDevice.city ? ` · ${personDevice.city}` : ""}</span>
                <span className="state-pill"><Timer size={12} /> آخر ظهور {formatWhen(personDevice.lastSeen)}</span>
              </div>
              <div className="subs-models">
                {providers.length === 0 ? <div className="admin-empty"><KeyRound size={23} /><span>أضف مزودًا أولًا من تبويب «مزودو الذكاء».</span></div> : providers.map(provider => {
                  const state = personStateFor(provider);
                  const entry = personGrants[String(provider.id)];
                  const active = state.key === "open";
                  const used = usageFor(provider.id);
                  return (
                    <div className={`subs-model-row ${state.key}`} key={provider.id}>
                      <div className="subs-model-main">
                        <b>{provider.name}{provider.premium ? <i className="subs-tag">مدفوع{provider.price ? ` · $${provider.price}` : ""}</i> : <i className="subs-tag free">مجاني</i>}</b>
                        <small dir="ltr">{provider.model}</small>
                        <small className="subs-api" dir="ltr">{provider.endpoint || "Endpoint افتراضي للمزود"}</small>
                      </div>
                      <div className="subs-model-info">
                        <span className={`subs-state ${state.key}`}>{state.key === "open" ? <Check size={12} /> : state.key === "paused" ? <Pause size={12} /> : state.key === "locked" || state.key === "revoked" ? <LockKeyhole size={12} /> : <Globe2 size={12} />} {state.label}</span>
                        <small>{active ? (entry?.expiresAt ? `حتى ${formatWhen(new Date(entry.expiresAt))}` : "مدى الحياه") : state.key === "paused" ? "الوقت محفوظ — اضغط «فتح» ليعود" : state.key === "free" ? "متاح للجميع تلقائيًا" : state.key === "revoked" ? "ممنوع لهذا الشخص" : "غير ممنوح لهذا الشخص"}</small>
                        <small className="subs-usage"><Gauge size={11} /> {tokenTotal(used).toLocaleString("ar-SA")} توكن (مدخل {(used?.promptTokens ?? 0).toLocaleString("ar-SA")} · مخرج {(used?.completionTokens ?? 0).toLocaleString("ar-SA")}) · {used?.messages ?? 0} رسالة</small>
                        <small className="subs-limit"><Gauge size={11} /> حد النموذج: {formatTokenLimit(provider.model)}</small>
                      </div>
                      <div className="subs-model-actions">
                        {state.key === "open" && <>
                          <button className="admin-primary small" disabled={renew.isPending} onClick={() => renewOne(provider.id)} title={`تجديد المدة (${durationLabel})`}><RotateCcw size={13} /> تجديد</button>
                          <button className="pause-button" disabled={pause.isPending} onClick={() => pauseOne(provider.id, true)} title="إيقاف مؤقت — الوقت يبقى محفوظًا"><Pause size={13} /> إيقاف مؤقت</button>
                        </>}
                        {state.key === "paused" && <>
                          <button className="admin-primary small" disabled={pause.isPending} onClick={() => pauseOne(provider.id, false)}><Play size={13} /> فتح</button>
                          <button className="pause-button" disabled={renew.isPending} onClick={() => renewOne(provider.id)} title={`تجديد المدة (${durationLabel})`}><RotateCcw size={13} /> تجديد</button>
                        </>}
                        {(state.key === "locked" || state.key === "free") && (
                          <button className="admin-primary small" disabled={grant.isPending} onClick={() => grantOne(provider.id)} title={`إضافة بمدة ${durationLabel}`}><Plus size={13} /> إضافة</button>
                        )}
                        {state.key === "revoked" ? (
                          <button className="unblock-button" disabled={revoke.isPending} onClick={() => revokeOne(provider.id, false)}>استعادة</button>
                        ) : (
                          <button className="block-button" disabled={revoke.isPending} onClick={() => revokeOne(provider.id, true)} title="إيقاف نهائي — يمنع النموذج لهذا الشخص حتى لو كان متاحًا للجميع">إيقاف نهائي</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {personReported.length > 0 && (
                <div className="subs-user-models">
                  <span className="device-control-label"><KeyRound size={13} /> نماذج أضافها بنفسه (بمفتاحه الخاص)</span>
                  <div className="reported-list">{personReported.map((item, index) => <span className="reported-chip" key={index}><b>{item.name}</b><small dir="ltr">{item.kind} · {item.model}</small><small dir="ltr">{item.endpoint || "Endpoint افتراضي"}</small><small>حد النموذج: {formatTokenLimit(item.model)}</small></span>)}</div>
                </div>
              )}
              <small className="form-security"><ShieldCheck size={13} /> أي نموذج جديد تضيفه للموقع يظهر هنا «مقفل» ولا يُفتح لهذا الشخص إلا عند «إضافة». «إيقاف مؤقت» يمنعه وتبقى المدة محفوظة، و«فتح» يعيده، و«إيقاف نهائي» يمنعه تمامًا. النموذج «المفتوح» هنا يخص هذا الشخص وحده ولا يظهر مفتوحًا لغيره.</small>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/* ===== لوحة جانبية (يمين) تعرض كل تفاصيل جهاز من شاشة الدعم الفني ===== */

function DeviceDetailsDrawer({ code, onClose }: { code: string; onClose: () => void }) {
  const query = trpc.admin.devices.list.useQuery();
  const thread = trpc.admin.support.thread.useQuery({ code }, { enabled: Boolean(code) });
  const device = (query.data?.devices ?? []).find(item => item.code === code);
  const providers = query.data?.providers ?? [];
  const reported = (query.data?.reportedProviders ?? []).filter(item => item.code === code);
  const rules = (query.data?.accessRules ?? []).filter(rule => rule.code === code || (Boolean(device?.ip) && rule.ip === device?.ip));
  const grants = parseGrantsClient(device?.providerGrants);
  const revokes = parseRevokesClient(device?.providerRevokes);
  const grantList = Object.entries(grants).filter(([, value]) => grantActive(value));
  const nameFor = (id: number) => providers.find(item => item.id === id)?.name ?? `نموذج #${id}`;
  return (
    <div className="device-drawer-backdrop" onClick={onClose}>
      <aside className="device-drawer glass" onClick={event => event.stopPropagation()}>
        <div className="device-drawer-head"><div><span className="admin-overline">DEVICE DETAILS</span><h3><Fingerprint size={15} /> {code}</h3></div><button className="icon-button" onClick={onClose} aria-label="إغلاق"><X size={17} /></button></div>
        <div className="device-drawer-body">
          {!device ? <div className="admin-empty"><Fingerprint size={22} /><span>لا توجد بيانات لهذا الجهاز بعد.</span></div> : <>
            <div className="drawer-grid">
              <div><small>IP</small><b dir="ltr">{device.ip ?? "—"}</b></div>
              <div><small>الموقع</small><b>{[device.city, device.region, device.country].filter(Boolean).join(" · ") || "غير معروف"}</b></div>
              <div><small>الإحداثيات</small><b dir="ltr">{device.latitude && device.longitude ? <a href={`https://www.google.com/maps?q=${encodeURIComponent(`${device.latitude},${device.longitude}`)}`} target="_blank" rel="noreferrer">{device.latitude}, {device.longitude}</a> : "—"}</b></div>
              <div><small>الرسائل</small><b>{device.messageCount}</b></div>
              <div><small>أول ظهور</small><b>{formatWhen(device.firstSeen)}</b></div>
              <div><small>آخر ظهور</small><b>{formatWhen(device.lastSeen)}</b></div>
              <div><small>Agent</small><b>{isActiveFlag(device.agentEnabled, device.agentExpiresAt) ? (device.agentExpiresAt ? `حتى ${formatWhen(device.agentExpiresAt)}` : "مدى الحياة") : "غير مفعّل"}</b></div>
              <div><small>الحظر</small><b>{isActiveFlag(device.banned, device.banExpiresAt) ? (device.banExpiresAt ? `حتى ${formatWhen(device.banExpiresAt)}` : "دائم") : "غير محظور"}</b></div>
            </div>
            {device.userAgent && <div className="drawer-line"><small>المتصفح</small><span dir="ltr">{device.userAgent}</span></div>}
            <div className="drawer-block"><b><Check size={13} /> النماذج الممنوحة</b>{grantList.length ? <div className="reported-list">{grantList.map(([key, value]) => <span className="reported-chip granted" key={key}><b>{nameFor(Number(key))}</b><small>{value.expiresAt ? `حتى ${formatWhen(new Date(value.expiresAt))}` : "مدى الحياه"}</small></span>)}</div> : <small className="drawer-muted">لا يوجد</small>}</div>
            <div className="drawer-block"><b><Ban size={13} /> الإلغاءات</b>{Object.keys(revokes).length ? <div className="reported-list">{Object.keys(revokes).map(key => <span className="reported-chip revoked" key={key}><b>{nameFor(Number(key))}</b></span>)}</div> : <small className="drawer-muted">لا يوجد</small>}</div>
            <div className="drawer-block"><b><ShieldCheck size={13} /> تصاريح الوصول</b>{rules.length ? <div className="reported-list">{rules.map(rule => <span className="reported-chip" key={rule.id}><b>{rule.allowAllPremium ? "كل النماذج المدفوعة" : rule.providerId ? nameFor(rule.providerId) : "—"}</b><small>{rule.code ? `بصمة ${rule.code}` : rule.ip}</small></span>)}</div> : <small className="drawer-muted">لا يوجد</small>}</div>
            <div className="drawer-block"><b><KeyRound size={13} /> نماذج أضافها الزائر بنفسه</b>{reported.length ? <div className="reported-list">{reported.map((item, index) => <span className="reported-chip" key={index}><b>{item.name}</b><small>{item.kind} · {item.model}</small></span>)}</div> : <small className="drawer-muted">لا يوجد</small>}</div>
            <div className="drawer-block"><b><Headset size={13} /> محادثة الدعم</b>{(thread.data?.messages ?? []).length ? <div className="drawer-thread">{(thread.data?.messages ?? []).map(message => <div className={`support-cmsg ${message.sender}`} key={message.id}><div className="support-bubble">{message.body}</div><small>{message.sender === "admin" ? "أنت" : code} · {fmtDate(message.createdAt)}</small></div>)}</div> : <small className="drawer-muted">لا توجد رسائل</small>}</div>
          </>}
        </div>
      </aside>
    </div>
  );
}

function Chats() {
  const list = trpc.admin.chats.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  const detail = trpc.admin.chats.get.useQuery({ id: selected ?? 0 }, { enabled: Boolean(selected) });
  const remove = trpc.admin.chats.delete.useMutation({ onSuccess: () => { list.refetch(); setSelected(null); toast.success("تم حذف المحادثة"); }, onError: error => toast.error(error.message) });
  return (
    <div className="admin-content">
      <div className="admin-section-intro"><div><span className="admin-overline">SAVED CHATS</span><h2>محادثات الزوار</h2><p>تُحفظ محادثات كل جهاز تلقائيًا حسب الـ IP وتُستعاد له بصمت. هنا تقرؤها أو تحذفها.</p></div><div className="privacy-note"><MessageSquareText size={15} /> محفوظة على الخادم</div></div>
      <div className="admin-grid-2">
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">CONVERSATIONS</span><h3>القائمة</h3></div><button onClick={() => list.refetch()}><RefreshCw size={15} /> تحديث</button></div>
          <div className="chat-admin-list">
            {(list.data ?? []).map(row => <button className={`chat-admin-row ${selected === row.id ? "active" : ""}`} key={row.id} onClick={() => setSelected(row.id)}><span className="chat-admin-copy"><b>{row.title || "محادثة بلا عنوان"}{row.tokens ? <i className="chat-tokens">{row.tokens.toLocaleString("ar-SA")} توكن</i> : null}</b><small>{row.code} · {row.ip ?? "—"} · {row.mode === "agent" ? "Agent" : "Ai Chat"} · {formatWhen(row.updatedAt)}{row.expiresAt ? ` · تُحذف ${formatWhen(row.expiresAt)}` : ""}</small></span></button>)}
            {!list.data?.length && <div className="admin-empty"><MessageSquareText size={23} /><span>لا توجد محادثات محفوظة بعد.</span></div>}
          </div>
        </section>
        <section className="admin-panel glass">
          <div className="admin-panel-head"><div><span className="admin-overline">TRANSCRIPT</span><h3>المحتوى</h3></div><div className="chat-admin-actions">{selected && <button className="delete-provider" onClick={() => remove.mutate({ id: selected })}><Trash2 size={15} /></button>}{selected && <button className="icon-button" onClick={() => setSelected(null)} aria-label="إغلاق"><X size={15} /></button>}</div></div>
          <div className="chat-admin-transcript">
            {!selected && <div className="admin-empty"><MessageSquareText size={23} /><span>اختر محادثة من القائمة لعرض محتواها.</span></div>}
            {selected && detail.data?.parsed?.map((message, index) => <div className={`chat-admin-msg ${message.role}`} key={`${message.id}-${index}`}><b>{message.role === "assistant" ? "Cz" : "الزائر"}</b>{message.model ? <small className="msg-model">{message.model}</small> : null}{message.tokens ? <small className="msg-tokens">{message.tokens.toLocaleString("ar-SA")} توكن</small> : null}<p>{message.content}</p></div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
