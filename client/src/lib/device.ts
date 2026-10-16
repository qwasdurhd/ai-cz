/**
 * Stable per-device code (a literal "fingerprint").
 * Generated once and kept in localStorage so it never changes for this device.
 * The admin uses this code to grant/deny Agent access and to ban a device.
 */
const STORAGE_KEY = "ai-cz.device-code.v1";
const CODE_RE = /^[A-Za-z0-9_-]{6,40}$/;

function randomCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

export function getDeviceCode(): string {
  try {
    let code = localStorage.getItem(STORAGE_KEY);
    if (!code || !CODE_RE.test(code)) {
      code = `cz-${randomCode(10)}`;
      localStorage.setItem(STORAGE_KEY, code);
    }
    return code;
  } catch {
    return `cz-${randomCode(10)}`;
  }
}

export const DEVICE_CODE = getDeviceCode();
