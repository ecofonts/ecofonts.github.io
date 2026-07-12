/**
 * Main-thread client for the pipeline worker: lazily spawns the worker on
 * first use, multiplexes jobs by id, and transparently falls back to running
 * the pipeline inline (the pre-worker behavior) when module workers are
 * unavailable or the worker script fails to boot.
 */
import type { EcoResult, ProgressCallback } from "./pipeline";
import type { EcoJobRequest, EcoJobResponse } from "./pipeline.worker";

interface PendingJob {
    resolve: (result: EcoResult) => void;
    reject: (err: Error) => void;
    onProgress?: ProgressCallback;
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
        } else if (message.type === "done") {
            pending.delete(message.id);
            job.resolve(message.result);
        } else {
            pending.delete(message.id);
            job.reject(new Error(message.message));
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
): Promise<EcoResult> {
    const { processUpload } = await import("./pipeline");
    return processUpload(file.name, await file.arrayBuffer(), intensityPercent, onProgress);
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
): Promise<EcoResult> {
    const target = getWorker();
    if (!target) return processInline(file, intensityPercent, onProgress);
    const id = nextJobId++;
    try {
        return await new Promise<EcoResult>((resolve, reject) => {
            pending.set(id, { resolve, reject, onProgress });
            target.postMessage({ id, file, intensityPercent } satisfies EcoJobRequest);
        });
    } catch (err) {
        if (err instanceof WorkerUnavailableError) {
            return processInline(file, intensityPercent, onProgress);
        }
        throw err;
    }
}
