import { UAParser } from "ua-parser-js";

/**
 * Device inference — the ONE place a raw user-agent (web) or an SDK $device
 * blob (mobile) becomes the {browser, os, device} vocabulary the product shows.
 *
 * Shared deliberately: the ingest path writes these onto each Session, and the
 * one-time backfill re-derives them for sessions that predate those columns. If
 * the two drifted, historical rows would disagree with live ones for the same
 * device — so both import from here rather than each parsing a UA their own way.
 */
export interface DeviceFacts {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  device: string | null;
  deviceModel: string | null;
}

export function inferBrowser(ua: string): string {
  const name = new UAParser(ua).getBrowser().name;
  if (!name) return "Other";
  if (/^Mobile Safari$/i.test(name)) return "Safari";
  if (/^WebKit$/i.test(name)) return "Safari";
  if (/^Edge|^Microsoft Edge/i.test(name)) return "Edge";
  return name;
}

/** Browser version from the UA (e.g. "126.0.0.0"). Null when unknown. */
export function inferBrowserVersion(ua: string): string | null {
  return new UAParser(ua).getBrowser().version ?? null;
}

/** OS version from the UA (e.g. "17.4", "10"). Null when unknown. */
export function inferOsVersion(ua: string): string | null {
  return new UAParser(ua).getOS().version ?? null;
}

export function inferOs(ua: string): string {
  const name = new UAParser(ua).getOS().name;
  if (!name) return "Other";
  if (/^Mac OS$/i.test(name)) return "macOS";
  if (/^iOS$/i.test(name)) return "iOS";
  if (/^Chromium OS$/i.test(name)) return "ChromeOS";
  return name;
}

export function inferDevice(ua: string, viewportWidth?: number): string {
  const t = new UAParser(ua).getDevice().type;
  if (t === "mobile") return "Mobile";
  if (t === "tablet") return "Tablet";
  if (t === "smarttv") return "TV";
  if (t === "wearable") return "Wearable";
  if (t === "console") return "Console";
  // ua-parser-js leaves `type` undefined for desktop; use viewport as a hint.
  if (typeof viewportWidth === "number" && viewportWidth > 0 && viewportWidth < 600)
    return "Mobile";
  if (
    typeof viewportWidth === "number" &&
    viewportWidth >= 600 &&
    viewportWidth < 1024
  )
    return "Tablet";
  return "Desktop";
}

/** Every device fact a WEB session carries, from its UA + viewport. Web UAs
 *  don't expose a hardware model, so `deviceModel` is always null. */
export function webDeviceFacts(ua: string, viewportWidth?: number): DeviceFacts {
  return {
    browser: inferBrowser(ua),
    browserVersion: inferBrowserVersion(ua),
    os: inferOs(ua),
    osVersion: inferOsVersion(ua),
    device: inferDevice(ua, viewportWidth),
    deviceModel: null,
  };
}

/**
 * Apple hardware identifier → marketing name. The iOS SDK reports the raw
 * `uname` machine string (e.g. "iPhone18,3"), which looks like "iPhone 18" to a
 * human but is actually the iPhone 17. This maps the identifiers to the real
 * marketing name. UNKNOWN identifiers fall through to the raw string, so a model
 * we don't have yet is shown accurately (as its identifier) rather than wrongly.
 * A maintenance table — extend it as Apple ships new hardware.
 */
const APPLE_MODEL_NAMES: Record<string, string> = {
  // iPhone
  "iPhone8,1": "iPhone 6s", "iPhone8,2": "iPhone 6s Plus", "iPhone8,4": "iPhone SE",
  "iPhone9,1": "iPhone 7", "iPhone9,3": "iPhone 7", "iPhone9,2": "iPhone 7 Plus", "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd gen)",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE (3rd gen)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
  // iPad (common recent)
  "iPad13,1": "iPad Air (4th gen)", "iPad13,2": "iPad Air (4th gen)",
  "iPad13,16": "iPad Air (5th gen)", "iPad13,17": "iPad Air (5th gen)",
  "iPad14,1": "iPad mini (6th gen)", "iPad14,2": "iPad mini (6th gen)",
  "iPad13,4": "iPad Pro 11-inch (3rd gen)", "iPad13,8": "iPad Pro 12.9-inch (5th gen)",
  "iPad14,3": "iPad Pro 11-inch (4th gen)", "iPad14,5": "iPad Pro 12.9-inch (6th gen)",
};

/**
 * Turn a raw hardware model into a human name. Apple identifiers (iPhoneX,Y /
 * iPadX,Y / iPodX,Y) map through APPLE_MODEL_NAMES; anything else — Android
 * models (already human, e.g. "Pixel 8"), unknown Apple ids, or a simulator
 * ("x86_64", "arm64") — passes through unchanged. Never returns a WRONG name.
 */
export function humanizeDeviceModel(
  raw: string | null | undefined,
): string | null {
  if (!raw) return raw ?? null;
  if (/^(iPhone|iPad|iPod)\d+,\d+$/.test(raw)) return APPLE_MODEL_NAMES[raw] ?? raw;
  return raw;
}

/** Every device fact a NATIVE session carries. The mobile SDK reports these
 *  directly at /start, so nothing is parsed — we only normalise into the same
 *  vocabulary the web path produces (Mobile/Tablet, iOS/Android). Native apps
 *  have no browser. The raw hardware model is humanised (iPhone18,3 → iPhone 17). */
export function mobileDeviceFacts(input: {
  platform: string | null | undefined;
  deviceType?: string | null;
  deviceModel?: string | null;
  osVersion?: string | null;
}): DeviceFacts {
  return {
    browser: null,
    browserVersion: null,
    os: (input.platform ?? "").toLowerCase() === "android" ? "Android" : "iOS",
    osVersion: input.osVersion ?? null,
    device:
      (input.deviceType ?? "").toLowerCase() === "tablet" ? "Tablet" : "Mobile",
    deviceModel: humanizeDeviceModel(input.deviceModel),
  };
}
