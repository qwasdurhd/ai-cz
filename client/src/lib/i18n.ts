// Tiny i18n helper for the public site.
// The React component keeps its own reactive `tr()`; module-scope helpers use
// `t()` with the globally synced language so thrown errors stay localized.
let current: "ar" | "en" = "ar";
try {
  if (typeof localStorage !== "undefined" && localStorage.getItem("ai-cz.lang.v1") === "en") current = "en";
} catch {
  /* ignore */
}

export function setLangGlobal(lang: "ar" | "en") {
  current = lang;
}

export function getLang(): "ar" | "en" {
  return current;
}

/** Return the Arabic or English variant depending on the active language. */
export function t(ar: string, en: string): string {
  return current === "ar" ? ar : en;
}
