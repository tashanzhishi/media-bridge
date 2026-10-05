/**
 * Download action handlers (open, remove, retry, start download, upload).
 */

import { VideoMetadata, DownloadStage } from "../core/types";
import { getDownload, deleteDownload } from "../core/database/downloads";
import { storeChunk } from "../core/database/chunks";
import { MessageType, CloudProvider } from "../shared/messages";
import { canCancelDownload } from "../core/utils/download-utils";
import { t } from "../shared/i18n";
import { loadDownloadStates } from "./state";
import { renderDownloads } from "./render-downloads";
import { renderDetectedVideos } from "./render-videos";

export async function handleOpenDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download || !download.localPath) {
      alert(t("error.fileNotFound"));
      return;
    }

    const filename = download.localPath.split(/[/\\]/).pop();
    if (!filename) {
      alert(t("error.filenameUnknown"));
      return;
    }

    const downloads = await new Promise<chrome.downloads.DownloadItem[]>(
      (resolve) => {
        chrome.downloads.search({ filenameRegex: filename }, resolve);
      },
    );

    if (downloads.length > 0) {
      chrome.downloads.show(downloads[0].id);
    } else {
      await chrome.downloads.showDefaultFolder();
    }
  } catch (error) {
    console.error("Failed to open download:", error);
    alert(t("error.openFailed"));
  }
}

export async function handleRemoveDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download) return;

    const isInProgress =
      download.progress.stage !== DownloadStage.COMPLETED &&
      download.progress.stage !== DownloadStage.FAILED &&
      download.progress.stage !== DownloadStage.CANCELLED;

    if (isInProgress) {
      if (!canCancelDownload(download.progress.stage)) {
        alert(t("error.cannotCancel"));
        return;
      }

      if (!confirm(t("actions.cancelConfirm"))) return;

      try {
        const response = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: MessageType.CANCEL_DOWNLOAD,
              payload: { id: downloadId },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(response);
            },
          );
        });

        if (response && response.success) {
          await loadDownloadStates();
          renderDownloads();
          renderDetectedVideos();
        } else if (response && response.error) {
          alert(response.error);
        }
      } catch (error: any) {
        console.error("Failed to cancel download:", error);
        alert(t("error.cancelFailed", { error: error?.message || t("common.unknownError") }));
      }
    } else {
      if (!confirm(t("actions.removeConfirm"))) return;

      await deleteDownload(downloadId);
      await loadDownloadStates();
      renderDownloads();
    }
  } catch (error) {
    console.error("Failed to remove download:", error);
    alert(t("error.removeFailed"));
  }
}

export async function handleRetryDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download) {
      alert(t("error.downloadNotFound"));
      return;
    }

    let website: string | undefined;
    try {
      const urlObj = new URL(download.metadata.pageUrl);
      website = urlObj.hostname.replace(/^www\./, "");
    } catch {
      if (download.url) {
        try {
          const urlObj = new URL(download.url);
          website = urlObj.hostname.replace(/^www\./, "");
        } catch {}
      }
    }

    const tabTitle = download.metadata.title;
    await deleteDownload(downloadId);

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url: download.url,
            metadata: download.metadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDownloads();
    } else if (response && response.error) {
      alert(response.error);
    }
  } catch (error: any) {
    console.error("Failed to retry download:", error);
    alert(t("error.retryFailed", { error: error?.message || t("common.unknownError") }));
  }
}

/**
 * Deferred upload: user selects the local file via the file picker,
 * then we send its bytes to the service worker for cloud upload.
 *
 * Chrome extensions cannot read local file paths directly; the user
 * must confirm by selecting the file (one click if still in Downloads).
 */
export async function handleUploadDownload(downloadId: string, provider: CloudProvider): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download) {
      alert(t("actions.uploadRecordNotFound"));
      return;
    }
    if (download.metadata.hasDrm) {
      alert(t("actions.drmUpload"));
      return;
    }

    // @ts-ignore — showOpenFilePicker is available in Chrome extension popups
    const [fileHandle] = await (window as any).showOpenFilePicker({
      multiple: false,
      types: [{ description: t("filePicker.videoFiles"), accept: { "video/*": [".mp4", ".webm", ".mkv", ".mov"] } }],
    });

    const file: File = await fileHandle.getFile();

    if (!file.type.startsWith('video/')) {
      alert(t("history.invalidFileType", { type: file.type }));
      return;
    }

    // Store file bytes in IDB — chrome.runtime.sendMessage uses JSON
    // serialization which destroys ArrayBuffer. IDB is shared across contexts.
    const tempKey = `__upload_${downloadId}`;
    await storeChunk(tempKey, 0, await file.arrayBuffer());

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.UPLOAD_REQUEST,
          payload: { downloadId, provider },
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        },
      );
    });

    if (response?.success) {
      await loadDownloadStates();
      renderDownloads();
    } else {
      alert(t("history.uploadFailed", { error: response?.error || t("common.unknownError") }));
    }
  } catch (err: any) {
    if (err?.name === "AbortError") return; // user cancelled file picker
    console.error("Upload failed:", err);
    alert(t("history.uploadFailed", { error: err?.message || t("common.unknownError") }));
  }
}

export async function startDownload(
  url: string,
  videoMetadata?: VideoMetadata,
  options: { triggerButton?: HTMLButtonElement } = {},
): Promise<void> {
  const triggerButton = options.triggerButton;
  const originalText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.classList.add("disabled");
    triggerButton.textContent = t("common.starting");
  }

  let shouldResetButton = false;

  try {
    if (chrome.runtime.lastError) {
      if (
        chrome.runtime.lastError.message?.includes(
          "Extension context invalidated",
        )
      ) {
        alert(t("actions.invalidatedRefresh"));
        shouldResetButton = true;
        return;
      }
    }

    let tabTitle: string | undefined;
    let website: string | undefined;
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        tabTitle = tab.title || undefined;
        if (tab.url) {
          try {
            const urlObj = new URL(tab.url);
            website = urlObj.hostname.replace(/^www\./, "");
          } catch {}
        }
      }
    } catch (error) {
      console.debug("Could not get tab information:", error);
    }

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url,
            metadata: videoMetadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const errorMessage = chrome.runtime.lastError.message || "";
            if (errorMessage.includes("Extension context invalidated")) {
              reject(
                new Error(t("actions.invalidatedReload")),
              );
              return;
            }
            reject(
              new Error(chrome.runtime.lastError.message || t("common.unknownError")),
            );
            return;
          }
          resolve(response);
        },
      );
    }).catch((error: any) => {
      if (error?.message?.includes("Extension context invalidated")) {
        throw new Error(t("actions.invalidatedReload"));
      }
      throw error;
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDetectedVideos();
    } else if (response && response.error) {
      const errorMessage = response.error;
      if (
        !errorMessage.includes("already") &&
        !errorMessage.includes("in progress")
      ) {
        alert(response.error);
      }
      await loadDownloadStates();
      renderDetectedVideos();
      shouldResetButton = true;
    }
  } catch (error: any) {
    console.error("Download request failed:", error);
    if (
      error?.message?.includes("Extension context invalidated") ||
      chrome.runtime.lastError?.message?.includes(
        "Extension context invalidated",
      )
    ) {
      alert(t("actions.invalidatedPopup"));
    } else {
      alert(t("actions.startFailed", { error: error?.message || t("common.unknownError") }));
    }
    shouldResetButton = true;
  } finally {
    if (shouldResetButton && triggerButton && triggerButton.isConnected) {
      triggerButton.disabled = false;
      triggerButton.classList.remove("disabled");
      triggerButton.textContent = originalText || t("videos.download");
    }
  }
}
