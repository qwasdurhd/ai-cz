import { describe, expect, it } from "vitest";
import { decryptAdminSecret, encryptAdminSecret, ipInAllowlist, parseAllowlist } from "./admin-auth";
import { evaluateQuota, getClientIp, matchesAccessRule } from "./admin-data";

describe("admin security helpers", () => {
  it("encrypts and decrypts server-side provider secrets", () => {
    const cipher = encryptAdminSecret("sk-private-test-key");
    expect(cipher).not.toContain("sk-private-test-key");
    expect(decryptAdminSecret(cipher)).toBe("sk-private-test-key");
  });

  it("resolves the real client IP behind the trusted proxy chain and ignores spoofed prefixes", () => {
    // [client-supplied fake], real client, Cloudflare edge, Render internal
    expect(getClientIp({ headers: { "x-forwarded-for": "203.0.113.7, 51.39.112.150, 172.68.1.1, 10.0.0.4" }, ip: "127.0.0.1" }, true)).toBe("51.39.112.150");
    expect(getClientIp({ headers: { "x-forwarded-for": "51.39.112.150, 172.68.1.1, 10.0.0.4" }, ip: "127.0.0.1" }, true)).toBe("51.39.112.150");
    expect(getClientIp({ headers: { "x-forwarded-for": "203.0.113.7" }, ip: "127.0.0.1" }, true)).toBe("203.0.113.7");
  });

  it("does not trust a spoofed forwarded IP when proxy trust is disabled", () => {
    expect(getClientIp({ headers: { "x-forwarded-for": "203.0.113.7" }, ip: "127.0.0.1" }, false)).toBe("127.0.0.1");
  });

  it("falls back to the direct request IP", () => {
    expect(getClientIp({ headers: {}, ip: "192.0.2.14" })).toBe("192.0.2.14");
  });

  it("stops a client exactly at the configured daily limit", () => {
    expect(evaluateQuota(20, 19)).toMatchObject({ allowed: true, remaining: 1 });
    expect(evaluateQuota(20, 20)).toMatchObject({ allowed: false, remaining: 0 });
    expect(evaluateQuota(0, 999)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("matches premium access by model and expiry", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(matchesAccessRule({ allowAllPremium: 0, providerId: 7, expiresAt: new Date("2026-09-27T12:00:00Z") }, 7, now)).toBe(true);
    expect(matchesAccessRule({ allowAllPremium: 1, providerId: null, expiresAt: new Date("2026-09-25T12:00:00Z") }, 7, now)).toBe(false);
  });

  it("parses an ADMIN_ALLOWED_IPS list", () => {
    expect(parseAllowlist("203.0.113.7, 10.0.0.0/24  192.168.1.5")).toEqual(["203.0.113.7", "10.0.0.0/24", "192.168.1.5"]);
  });

  it("allows everyone when the control-panel allowlist is empty", () => {
    expect(ipInAllowlist("203.0.113.7", [])).toBe(true);
  });

  it("locks the control panel to the configured IPs and CIDRs only", () => {
    const rules = ["203.0.113.7", "10.0.0.0/24"];
    expect(ipInAllowlist("203.0.113.7", rules)).toBe(true);
    expect(ipInAllowlist("10.0.0.42", rules)).toBe(true);
    expect(ipInAllowlist("10.0.1.42", rules)).toBe(false);
    expect(ipInAllowlist("198.51.100.9", rules)).toBe(false);
    expect(ipInAllowlist("unknown", rules)).toBe(false);
  });

  it("always trusts loopback so local development never locks out", () => {
    expect(ipInAllowlist("127.0.0.1", ["203.0.113.7"])).toBe(true);
    expect(ipInAllowlist("::1", ["203.0.113.7"])).toBe(true);
  });
});
