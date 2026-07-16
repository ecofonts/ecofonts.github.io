/**
 * Dedicated worker hosting the processing pipeline. Running the geometry off
 * the main thread keeps the page responsive during heavy glyphs and — the
 * reason this file exists — sidesteps background-tab throttling: browsers
 * clamp hidden-tab main-thread timers to ≥1s (one per minute after a few
 * minutes in Chrome), which stalls the pipeline's cooperative yields, but
 * dedicated workers are exempt, so processing continues at full speed when
 * the user switches tabs.
 *
 * Protocol: one {@link EcoJobRequest} in, a stream of progress messages and
 * a final done/error {@link EcoJobResponse} out, correlated by job id.
 */
import { processUpload, type EcoResult, type ProgressInfo } from "./pipeline";

export interface EcoJobRequest {
    id: number;
    /** Structured-cloned File — a handle, not a byte copy; read here. */
    file: File;
    /** Slider value, 1–20. */
    intensityPercent: number;
}

export type EcoJobResponse =
    | { id: number; type: "progress"; info: ProgressInfo }
    | { id: number; type: "done"; result: EcoResult }
    | { id: number; type: "error"; message: string };

// Typed as `Worker` to avoid the `webworker` TS lib, which conflicts with
// `dom` inside a single tsconfig. The relevant members are identical.
const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<EcoJobRequest>) => {
    const { id, file, intensityPercent } = event.data;
    try {
        const data = await file.arrayBuffer();
        const result = await processUpload(file.name, data, intensityPercent, (info) =>
            ctx.postMessage({ id, type: "progress", info } satisfies EcoJobResponse),
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
        ctx.postMessage({
            id,
            type: "error",
            message: err instanceof Error ? err.message : String(err),
        } satisfies EcoJobResponse);
    }
};
