export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  adminSecret: process.env.ADMIN_SECRET ?? process.env.JWT_SECRET ?? "",
  trustProxy: process.env.TRUST_PROXY === "1",
  // Number of trusted proxy hops appended to X-Forwarded-For by the hosting edge
  // (Render: Cloudflare edge + internal router = 2). The real client address sits
  // that many entries from the right, so client-prepended values are ignored and
  // the admin IP allowlist cannot be spoofed.
  trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? "2") || 0,
  // Comma/space separated IPs and IPv4 CIDRs allowed to reach the control panel.
  // Empty = no IP restriction (still password protected). Loopback is always
  // allowed so local development never locks you out.
  adminAllowedIps: process.env.ADMIN_ALLOWED_IPS ?? "",
};
