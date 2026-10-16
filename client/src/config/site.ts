// Ai - Cz brand configuration. Edit this file to rebrand the app or add built-in providers.
export type ProviderKind = "demo" | "openai" | "anthropic" | "google" | "openrouter" | "custom" | "czai";

export const SITE_CONFIG = {
  name: "Ai - Cz",
  shortName: "Cz",
  tagline: "مساحتك الذكية، بطريقتك",
  description: "واجهة محادثة خاصة وسريعة تجمع نماذج الذكاء الاصطناعي في مكان واحد.",
  footerNote: "خصوصيتك أولاً — لا تسجيل دخول، ولا حفظ للمفاتيح على الخادم.",
};

export type BuiltInProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  isDemo?: boolean;
};

// لا مزودات مدمجة: لا يرد الموقع إلا بعد أن تضيف مفتاح API خاصًا بك.
export const DEFAULT_PROVIDERS: BuiltInProvider[] = [];
