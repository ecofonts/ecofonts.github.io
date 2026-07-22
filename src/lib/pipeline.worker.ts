/**
 * Dedicated worker hosting the processing pipeline. Running the geometry off
 * the main thread keeps the page responsive during heavy glyphs and — the
 * reason this file exists — sidesteps background-tab throttling: browsers
 * clamp hidden-tab main-thread timers to ≥1s (one per minute after a few
 * minutes in Chrome), which stalls the pipeline's cooperative yields, but
 * dedicated workers are exempt, so processing continues at full speed when
 * the user switches tabs.
 *
 * Protocol: one job {@link EcoWorkerRequest} in, a stream of progress
 * messages and a final done/error {@link EcoJobResponse} out, correlated by
 * job id. When a PDF references fonts it does not embed, the worker sends
 * "need-local-fonts" and suspends the job until the matching "local-fonts"
 * request arrives — the Local Font Access API only exists on the main
 * thread, so the client answers from there.
 */
import { describeError, type ErrorReport } from "./errorMessage";
import {
    processUpload,
    type EcoResult,
    type LocalFontResolver,
    type ProgressInfo,
} from "./pipeline";

export type EcoWorkerRequest =
    | {
          type: "job";
          id: number;
          /** Structured-cloned File — a handle, not a byte copy; read here. */
          file: File;
          /** Slider value, 1–20. */
          intensityPercent: number;
          /** Whether the client can answer a "need-local-fonts" request. */
          canResolveLocalFonts: boolean;
      }
    | {
          type: "local-fonts";
          id: number;
          /** Installed-font bytes by PostScript name; misses are absent. */
          fonts: Record<string, ArrayBuffer>;
      };

export type EcoJobResponse =
    | { id: number; type: "progress"; info: ProgressInfo }
    | { id: number; type: "need-local-fonts"; names: string[] }
    | { id: number; type: "done"; result: EcoResult }
    | ({ id: number; type: "error" } & ErrorReport);

// Typed as `Worker` to avoid the `webworker` TS lib, which conflicts with
// `dom` inside a single tsconfig. The relevant members are identical.
const ctx = self as unknown as Worker;

/** Jobs waiting on the main thread's "local-fonts" answer, by job id. */
const fontWaiters = new Map<number, (fonts: Record<string, ArrayBuffer>) => void>();

ctx.onmessage = async (event: MessageEvent<EcoWorkerRequest>) => {
    const message = event.data;
    if (message.type === "local-fonts") {
        fontWaiters.get(message.id)?.(message.fonts);
        fontWaiters.delete(message.id);
        return;
    }
    const { id, file, intensityPercent, canResolveLocalFonts } = message;
    const resolveLocalFonts: LocalFontResolver | undefined = canResolveLocalFonts
        ? (names) =>
              new Promise((resolve) => {
                  fontWaiters.set(id, resolve);
                  ctx.postMessage({ id, type: "need-local-fonts", names } satisfies EcoJobResponse);
              })
        : undefined;
    try {
        const data = await file.arrayBuffer();
        const result = await processUpload(
            file.name,
            data,
            intensityPercent,
            (info) => ctx.postMessage({ id, type: "progress", info } satisfies EcoJobResponse),
            resolveLocalFonts,
        );
        // Transfer the result buffers back (zero-copy). Dedupe: the single
        // font path aliases `data` and the preview buffers to the same
        // ArrayBuffer, and a repeated entry in a transfer list throws.
        const transfer = [
            ...new Set(
                [result.data, result.previewOriginalData, result.previewProcessedData].filter(
                    (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
                ),
            ),
        ];
        ctx.postMessage({ id, type: "done", result } satisfies EcoJobResponse, transfer);
    } catch (err) {
        // Name and stack included: the browser APIs in this path (the File
        // read above, the dynamic imports inside the pipeline) throw
        // DOMExceptions whose message on its own says nothing useful.
        ctx.postMessage({
            id,
            type: "error",
            ...describeError(err),
        } satisfies EcoJobResponse);
    } finally {
        fontWaiters.delete(id);
    }
};
