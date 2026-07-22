/**
 * Main-thread client for the pipeline worker: lazily spawns the worker on
 * first use, multiplexes jobs by id, and transparently falls back to running
 * the pipeline inline (the pre-worker behavior) when module workers are
 * unavailable or the worker script fails to boot. Also answers the worker's
 * "need-local-fonts" requests — the Local Font Access API only exists on
 * the main thread, so the resolver runs here and the bytes are transferred
 * into the worker.
 */
import { rebuildError } from "./errorMessage";
import type { EcoResult, LocalFontResolver, ProgressCallback } from "./pipeline";
import type { EcoJobResponse, EcoWorkerRequest } from "./pipeline.worker";

interface PendingJob {
    resolve: (result: EcoResult) => void;
    reject: (err: Error) => void;
    onProgress?: ProgressCallback;
    resolveLocalFonts?: LocalFontResolver;
}

/** Sentinel for "the worker never booted" — jobs rerun inline on catch. */
class WorkerUnavailableError extends Error {}

let worker: Worker | null = null;
/** Set once a worker fails to boot; all later jobs skip straight to inline. */
let workerBroken = false;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();

function getWorker(): Worker | null {
    if (workerBroken || typeof Worker === "undefined") return null;
    if (worker) return worker;
    try {
        worker = new Worker(new URL("./pipeline.worker.ts", import.meta.url), {
            type: "module",
        });
    } catch {
        workerBroken = true;
        return null;
    }
    worker.onmessage = (event: MessageEvent<EcoJobResponse>) => {
        const message = event.data;
        const job = pending.get(message.id);
        if (!job) return;
        if (message.type === "progress") {
            job.onProgress?.(message.info);
        } else if (message.type === "need-local-fonts") {
            // The worker suspends its job until this answer arrives, so
            // always reply — an absent resolver just resolves nothing.
            void (async () => {
                let fonts: Record<string, ArrayBuffer> = {};
                try {
                    fonts = (await job.resolveLocalFonts?.(message.names)) ?? {};
                } catch {
                    fonts = {};
                }
                const transfer = [...new Set(Object.values(fonts))];
                worker?.postMessage(
                    { type: "local-fonts", id: message.id, fonts } satisfies EcoWorkerRequest,
                    transfer,
                );
            })();
        } else if (message.type === "done") {
            pending.delete(message.id);
            job.resolve(message.result);
        } else {
            pending.delete(message.id);
            // Rebuilt rather than re-wrapped, so the failure keeps the name
            // and stack it had inside the worker.
            job.reject(rebuildError(message));
        }
    };
    // Fires when the worker script fails to load or evaluate (no module
    // worker support, broken deploy) — per-job errors are caught inside the
    // worker and arrive as "error" responses instead.
    worker.onerror = () => {
        workerBroken = true;
        worker?.terminate();
        worker = null;
        const jobs = [...pending.values()];
        pending.clear();
        for (const job of jobs) job.reject(new WorkerUnavailableError());
    };
    return worker;
}

async function processInline(
    file: File,
    intensityPercent: number,
    onProgress?: ProgressCallback,
    resolveLocalFonts?: LocalFontResolver,
): Promise<EcoResult> {
    const { processUpload } = await import("./pipeline");
    return processUpload(
        file.name,
        await file.arrayBuffer(),
        intensityPercent,
        onProgress,
        resolveLocalFonts,
    );
}

/**
 * Process one upload off the main thread. Same contract as
 * `processUpload`, but takes the File directly (its bytes are read inside
 * the worker) and survives the tab being backgrounded mid-job.
 */
export async function processUploadInWorker(
    file: File,
    intensityPercent: number,
    onProgress?: ProgressCallback,
    resolveLocalFonts?: LocalFontResolver,
): Promise<EcoResult> {
    const target = getWorker();
    if (!target) return processInline(file, intensityPercent, onProgress, resolveLocalFonts);
    const id = nextJobId++;
    try {
        return await new Promise<EcoResult>((resolve, reject) => {
            pending.set(id, { resolve, reject, onProgress, resolveLocalFonts });
            target.postMessage({
                type: "job",
                id,
                file,
                intensityPercent,
                canResolveLocalFonts: Boolean(resolveLocalFonts),
            } satisfies EcoWorkerRequest);
        });
    } catch (err) {
        if (err instanceof WorkerUnavailableError) {
            return processInline(file, intensityPercent, onProgress, resolveLocalFonts);
        }
        throw err;
    }
}
