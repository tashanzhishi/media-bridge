/**
 * MSE / DASH segment detection handler.
 *
 * Many sites (e.g. bilibili) play video through Media Source Extensions (MSE):
 * the `<video>` element's source is a `blob:` URL and no `.mpd` manifest is ever
 * requested. Instead the player fetches the media as `.m4s`/`.m4a` (or ranged
 * `video/*`/`audio/*`) requests and feeds them to `SourceBuffer`.
 *
 * This handler sniffs those segment requests, collects the recently active
 * stream URLs and emits a single {@link VideoMetadata} entry carrying up to two
 * of them (the main track plus a second, usually the audio track). The existing
 * DASH download pipeline fetches both and lets FFmpeg pick the best video and
 * the best audio stream across the inputs — so it works even when the CDN does
 * not distinguish the two tracks via Content-Type (as bilibili does not).
 *
 * Only the currently playing rendition is captured — sniffing reflects whatever
 * the player actually requested from the network.
 */

import { VideoMetadata, VideoFormat } from "../../types";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../thumbnail-utils";

/** Metadata about a sniffed network request, forwarded from the service worker. */
export interface SegmentRequestInfo {
  url: string;
  contentType?: string;
  contentRange?: string;
  statusCode?: number;
}

export interface MseSegmentDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
  onVideoRemoved?: (url: string) => void;
}

/** Video and audio tracks must be observed within this window to be paired. */
const PAIR_WINDOW_MS = 5_000;
/** Wait after the last observed request before emitting (lets video+audio arrive together). */
const EMIT_DEBOUNCE_MS = 600;
/** Maximum number of candidate stream URLs kept per page. */
const MAX_CANDIDATES = 3;

const SEGMENT_EXTENSIONS = [".m4s", ".m4a", ".mp4"];

/** Parse the total resource size from a `Content-Range: bytes a-b/total` header. */
function parseTotalBytes(contentRange?: string): number | undefined {
  if (!contentRange) return undefined;
  const match = contentRange.match(/^bytes\s+\d+-\d+\/(\d+)/i);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

interface Candidate {
  url: string;
  at: number;
  /** Insertion order — used as a stable tiebreaker. */
  seq: number;
  /** Total resource size parsed from Content-Range, when available. */
  total?: number;
}

/**
 * MSE segment detection handler
 */
export class MseSegmentDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;

  /** Recently active stream URLs, most recent first. */
  private candidates: Candidate[] = [];
  private nextSeq = 0;
  /** URL explicitly identified as audio by Content-Type / extension, if any. */
  private explicitAudioUrl: string | null = null;
  private lastPrimaryUrl: string | null = null;
  private lastEmittedKey = "";
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MseSegmentDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
  }

  destroy(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.candidates = [];
    this.nextSeq = 0;
    this.explicitAudioUrl = null;
    this.lastPrimaryUrl = null;
    this.lastEmittedKey = "";
  }

  /** Whether this request looks like an MSE media segment we should sniff. */
  isSegmentRequest(info: SegmentRequestInfo): boolean {
    return this.segmentExtension(info) !== "" || this.isMediaContentType(info);
  }

  /** Feed a completed network request into the sniffer. */
  handleRequest(info: SegmentRequestInfo): void {
    if (!this.isSegmentRequest(info)) return;

    const now = Date.now();
    const extension = this.segmentExtension(info);
    if (extension === ".mp4" && !this.isMediaContentType(info)) {
      // Plain .mp4 XHR without a media Content-Type — not a media segment.
      return;
    }

    const existing = this.candidates.find((c) => c.url === info.url);
    if (existing) {
      existing.at = now;
      existing.total = parseTotalBytes(info.contentRange) ?? existing.total;
    } else {
      logger.debug("[Media Bridge] MSE stream detected", { url: info.url });
      this.candidates.unshift({
        url: info.url,
        at: now,
        seq: this.nextSeq++,
        total: parseTotalBytes(info.contentRange),
      });
    }

    if (this.isAudioTrack(info)) {
      this.explicitAudioUrl = info.url;
    }

    // Drop stale candidates (previous renditions / previous video of an SPA).
    this.candidates = this.candidates
      .filter((c) => now - c.at <= PAIR_WINDOW_MS)
      .slice(0, MAX_CANDIDATES);
    if (
      this.explicitAudioUrl &&
      !this.candidates.some((c) => c.url === this.explicitAudioUrl)
    ) {
      this.explicitAudioUrl = null;
    }

    this.scheduleEmit();
  }

  /**
   * Extension of the request path if it looks like a media segment, else "".
   */
  private segmentExtension(info: SegmentRequestInfo): string {
    try {
      const pathname = new URL(info.url).pathname.toLowerCase();
      return SEGMENT_EXTENSIONS.find((ext) => pathname.endsWith(ext)) || "";
    } catch {
      const lower = info.url.toLowerCase();
      return SEGMENT_EXTENSIONS.find((ext) => lower.includes(ext)) || "";
    }
  }

  private isMediaContentType(info: SegmentRequestInfo): boolean {
    const contentType = (info.contentType || "").toLowerCase();
    return contentType.startsWith("video/") || contentType.startsWith("audio/");
  }

  /** Whether a request is explicitly identifiable as an audio track. */
  private isAudioTrack(info: SegmentRequestInfo): boolean {
    const contentType = (info.contentType || "").toLowerCase();
    return contentType.startsWith("audio/") || this.segmentExtension(info) === ".m4a";
  }

  private scheduleEmit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, EMIT_DEBOUNCE_MS);
  }

  private emit(): void {
    const now = Date.now();
    const fresh = this.candidates.filter((c) => now - c.at <= PAIR_WINDOW_MS);
    if (fresh.length === 0) return;

    // The current rendition is the pair of most recently *discovered* URLs
    // (bilibili mints fresh signed URLs for both tracks on every quality change).
    // Within that pair the larger resource is the video track.
    //
    // Using first-seen order (seq) rather than last-activity keeps the selection
    // stable while the player alternates byte-range requests for both tracks;
    // otherwise the emitted key would flip and the UI card would flicker.
    const current = [...fresh].sort((a, b) => b.seq - a.seq).slice(0, 2);
    const ordered = [...current].sort(
      (a, b) => (b.total ?? 0) - (a.total ?? 0) || a.seq - b.seq,
    );

    const explicitAudio = this.explicitAudioUrl;
    const primary =
      ordered.find((c) => c.url !== explicitAudio)?.url ?? ordered[0].url;

    // Second input for the mux: the explicit audio track if known, otherwise the
    // next most significant stream (usually the audio track on bilibili).
    const secondary =
      explicitAudio && explicitAudio !== primary
        ? explicitAudio
        : ordered.find((c) => c.url !== primary)?.url ?? null;

    // The rendition changed (quality switch / new video): drop the old card.
    if (this.lastPrimaryUrl && this.lastPrimaryUrl !== primary) {
      this.onVideoRemoved?.(this.lastPrimaryUrl);
    }

    const emitKey = `${primary}|${secondary ?? ""}`;
    if (emitKey === this.lastEmittedKey) return;
    this.lastEmittedKey = emitKey;
    this.lastPrimaryUrl = primary;

    const metadata = this.buildMetadata(primary, secondary);
    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }
  }

  private buildMetadata(videoUrl: string, audioUrl: string | null): VideoMetadata | null {
    const videoElement = document.querySelector("video");

    const metadata: VideoMetadata = {
      url: videoUrl,
      audioUrl: audioUrl ?? undefined,
      format: VideoFormat.DASH,
      isMseStream: true,
      fileExtension: "mp4",
      pageUrl: window.location.href,
      title: document.title,
    };

    if (videoElement) {
      const width = videoElement.videoWidth;
      const height = videoElement.videoHeight;
      if (width) metadata.width = width;
      if (height) metadata.height = height;
      if (videoElement.duration && Number.isFinite(videoElement.duration)) {
        metadata.duration = videoElement.duration;
      }
      if (width && height) {
        if (height >= 2160) metadata.resolution = "4K";
        else if (height >= 1440) metadata.resolution = "1440p";
        else if (height >= 1080) metadata.resolution = "1080p";
        else if (height >= 720) metadata.resolution = "720p";
        else if (height >= 480) metadata.resolution = "480p";
        else metadata.resolution = `${height}p`;
      }
    }

    const thumbnail = extractThumbnail(videoElement ?? undefined);
    if (thumbnail) metadata.thumbnail = thumbnail;

    return metadata;
  }
}
