/**
 * Lightweight i18n layer for the Media Bridge extension UI.
 *
 * Supported locales: English (`en`) and Simplified Chinese (`zh`).
 * This module intentionally has no dependency on any `core/` module so it can
 * be imported from the popup, options page and service worker without creating
 * cycles. Consumers resolve the locale from settings and call `setLocale()`.
 */

import { MESSAGES } from "./i18n-messages";

export type Locale = "en" | "zh";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh"];

/** Locale used when the browser UI language cannot be determined. */
const FALLBACK_LOCALE: Locale = "en";

/**
 * Detect the default locale from the browser UI language.
 * Chinese browsers (zh-CN, zh-TW, zh-HK, …) default to `zh`, everything else
 * to `en`.
 */
export function detectDefaultLocale(): Locale {
  try {
    const uiLanguage = chrome?.i18n?.getUILanguage?.() ?? "";
    return uiLanguage.toLowerCase().startsWith("zh") ? "zh" : FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** Normalize an arbitrary stored value into a supported locale. */
export function normalizeLocale(value: unknown): Locale {
  return value === "en" || value === "zh" ? value : detectDefaultLocale();
}

let currentLocale: Locale = detectDefaultLocale();

export function setLocale(locale: Locale): void {
  currentLocale = normalizeLocale(locale);
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate a key with optional `{placeholder}` substitutions.
 * Falls back to the English string, then to the raw key.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const localized = MESSAGES[currentLocale]?.[key];
  const english = MESSAGES.en?.[key];
  let result = localized ?? english ?? key;

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      result = result.split(`{${name}}`).join(String(value));
    }
  }
  return result;
}

/**
 * Apply translations to a DOM subtree using `data-i18n*` attributes:
 * - `data-i18n`            → textContent
 * - `data-i18n-html`       → innerHTML (trusted, local dictionary only)
 * - `data-i18n-placeholder`→ placeholder
 * - `data-i18n-title`      → title
 * - `data-i18n-aria-label` → aria-label
 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n") || "");
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.getAttribute("data-i18n-html") || "");
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    (el as HTMLInputElement).placeholder = t(el.getAttribute("data-i18n-placeholder") || "");
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title") || "");
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label") || ""));
  });
}

/** Reveal a document hidden by the `i18n-pending` guard class. */
export function revealDocument(): void {
  document.documentElement.classList.remove("i18n-pending");
}

/**
 * Set the locale and translate the whole document. Safe to call once per page
 * load, right after settings are loaded.
 */
export function initI18n(locale: Locale): void {
  setLocale(locale);
  document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
  applyI18n(document);
  revealDocument();
}

/** Map pipeline stream labels used inside FFmpeg progress messages. */
function translateStreamLabel(label: string): string {
  if (getLocale() === "zh") {
    const map: Record<string, string> = { video: "视频", audio: "音频", media: "媒体" };
    return map[label.toLowerCase()] ?? label;
  }
  return label;
}

/**
 * Translate a runtime message emitted by the download pipeline (progress
 * details, upload status, known error constants). Unknown messages are returned
 * unchanged. Messages whose locale could not be resolved stay as-is.
 */
export function translateRuntimeMessage(message: string): string {
  if (!message) return message;

  const lang = getLocale();

  const exact: Record<string, string> = {
    "Uploading to cloud...": "progress.uploadingToCloud",
    "Upload interrupted": "progress.uploadInterrupted",
    "Upload complete": "progress.uploadComplete",
    "Upload cancelled": "progress.uploadCancelled",
    "Downloading...": "progress.downloading",
    "Download completed": "progress.downloadCompleted",
    "Recording...": "stage.recording",
    "Concatenating chunks": "progress.concatChunks",
    "Concatenating segments": "progress.concatSegments",
    "Writing video stream": "progress.writeVideoStream",
    "Writing audio stream": "progress.writeAudioStream",
    "Writing media stream": "progress.writeMediaStream",
    "Merging video and audio": "progress.mergingStreams",
    "Converting to MP4": "progress.convertingMp4",
    "Done": "progress.done",
    "Cannot cancel download during merging or saving phase. Chunks are already downloaded and processing is in progress.":
      "error.cannotCancel",
  };

  const exactKey = exact[message];
  if (exactKey && (lang === "zh" || MESSAGES.en[exactKey])) {
    return t(exactKey);
  }

  let match = message.match(/^Uploading\.\.\.\s*(\d+)%$/);
  if (match) return t("progress.uploadingPercent", { pct: match[1] });

  match = message.match(/^Downloaded\s+(.+?)\s*\/\s*(.+)$/);
  if (match) return t("progress.downloadedOf", { done: match[1], total: match[2] });

  match = message.match(/^(\d+)\s+segments collected$/);
  if (match) return t("progress.segmentsCollected", { count: match[1] });

  match = message.match(/^Format:\s*(.+)$/);
  if (match) return t("progress.format", { format: match[1] });

  match = message.match(/^Concatenating\s+(.+?)\s+chunks$/);
  if (match) return t("progress.concatStreamChunks", { label: translateStreamLabel(match[1]) });

  match = message.match(/^Writing\s+(.+?)\s+stream$/);
  if (match) return t("progress.writeStream", { label: translateStreamLabel(match[1]) });

  return message;
}
