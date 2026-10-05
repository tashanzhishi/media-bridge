/**
 * bilibili MAIN-world content script.
 *
 * Runs in the page's JavaScript context (`world: "MAIN"`) so it can read the
 * play information bilibili exposes on `window.__playinfo__` and hook the
 * `playurl` fetch/XHR responses. The captured DASH video/audio URLs are the only
 * reliable way to know which track is audio — sniffing the segment requests
 * cannot distinguish them (bilibili serves both as `video/mp4`).
 *
 * The result is forwarded to the isolated content script via `window.postMessage`.
 */

const MESSAGE_SOURCE = "media-bridge-bilibili-playinfo";
const PLAY_URL_RE =
  /\/x\/player\/(?:wbi\/)?playurl|\/pgc\/player\/web\/playurl|\/x\/player\/v2\/playurl/i;

interface DashTrack {
  baseUrl?: string;
  backupUrl?: string[];
  id?: number;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
}

interface DashInfo {
  video?: DashTrack[];
  audio?: DashTrack[];
}

const seenKeys = new Set<string>();

function isPlayUrl(url: unknown): boolean {
  return typeof url === "string" && PLAY_URL_RE.test(url);
}

/** Extract the DASH section from a playurl response (handles wrapped payloads). */
function extractDash(payload: any): DashInfo | null {
  const data = payload?.data ?? payload;
  const dash = data?.dash;
  if (!dash || !Array.isArray(dash.video) || dash.video.length === 0) return null;
  return {
    video: dash.video,
    audio: Array.isArray(dash.audio) ? dash.audio : [],
  };
}

function postDash(payload: any, force = false): void {
  const dash = extractDash(payload);
  if (!dash) return;

  const serialize = (track: DashTrack) => ({
    baseUrl: track.baseUrl,
    backupUrl: track.backupUrl?.[0],
    id: track.id,
    bandwidth: track.bandwidth,
    width: track.width,
    height: track.height,
    codecs: track.codecs,
    mimeType: track.mimeType,
  });

  const video = dash.video!.map(serialize).filter((t) => t.baseUrl);
  const audio = (dash.audio ?? []).map(serialize).filter((t) => t.baseUrl);
  if (video.length === 0) return;

  const key = video.map((t) => t.baseUrl).join("|") + "::" + audio.map((t) => t.baseUrl).join("|");
  if (!force && seenKeys.has(key)) return;
  seenKeys.add(key);

  window.postMessage({ source: MESSAGE_SOURCE, payload: { video, audio } }, "*");
}

function captureFromPlayInfo(force = false): void {
  try {
    postDash((window as any).__playinfo__, force);
  } catch {
    // Ignore malformed / unavailable play info
  }
}

// ---- Hook fetch ----
try {
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(...args: Parameters<typeof fetch>) {
    const request = args[0];
    const url = typeof request === "string" ? request : (request as Request)?.url;
    const promise = originalFetch.apply(window, args);

    if (isPlayUrl(url)) {
      promise
        .then((response) => {
          response
            .clone()
            .json()
            .then((json) => postDash(json))
            .catch(() => {});
        })
        .catch(() => {});
    }
    return promise;
  } as typeof fetch;
} catch {
  // Ignore — fetch may be non-configurable
}

// ---- Hook XMLHttpRequest ----
try {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest & { __mbUrl?: string },
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    this.__mbUrl = typeof url === "string" ? url : url?.toString();
    return (originalOpen as any).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest & { __mbUrl?: string },
    ...args: any[]
  ) {
    if (isPlayUrl(this.__mbUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "json") {
            postDash(this.response);
          } else if (this.responseType === "" || this.responseType === "text") {
            postDash(JSON.parse(this.responseText));
          }
        } catch {
          // Ignore non-JSON / parse errors
        }
      });
    }
    return (originalSend as any).apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;
} catch {
  // Ignore — XHR may be non-configurable
}

// ---- Read the injected play info (initial load + SPA navigation) ----
// The isolated content script runs later (document_idle), so the first posts may
// be missed. Repeat unconditionally for the first ~15s so it always receives the
// current stream; afterwards only report changes.
captureFromPlayInfo(true);
let attempts = 0;
const pollTimer = setInterval(() => {
  attempts++;
  captureFromPlayInfo(attempts <= 15);
  if (attempts >= 120) clearInterval(pollTimer);
}, 1_000);

window.addEventListener("popstate", () => captureFromPlayInfo());
window.addEventListener("load", () => captureFromPlayInfo(true));
