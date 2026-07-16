import { useEffect, useRef, useState } from "react";
import type { EcoResult, ProgressInfo } from "../lib/pipeline";
import { validateSelection } from "../lib/limits";
import "./FontOptimizer.css";

const DEFAULT_PREVIEW_TEXT = "Handgloves 0123";
const PREVIEW_FAMILY_ORIGINAL = "eco-preview-original";
const PREVIEW_FAMILY_ECO = "eco-preview-eco";

declare global {
    interface Window {
        umami?: { track: (event: string, data?: Record<string, string | number>) => void };
    }
}

// The umami script is loaded async and may be blocked; never let analytics
// interfere with processing.
function trackOptimize(file: File, intensity: number) {
    try {
        window.umami?.track("optimize", {
            type: file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() || "unknown",
            intensity,
        });
    } catch {}
}

export default function FontOptimizer() {
    const [files, setFiles] = useState<File[]>([]);
    const [intensity, setIntensity] = useState(10);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
    const [progress, setProgress] = useState<ProgressInfo | null>(null);
    const [results, setResults] = useState<EcoResult[]>([]);
    const [failures, setFailures] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
    const [previewReady, setPreviewReady] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const printFrameRef = useRef<HTMLIFrameElement | null>(null);

    // Drop the print iframe (and its blob URL) when the component unmounts.
    useEffect(() => removePrintFrame, []);

    const preview =
        results.find((result) => result.previewProcessedData && result.previewOriginalData) ??
        null;

    // Load the before/after fonts as real web fonts: the browser's native
    // text rendering gives full quality, wrapping and selection for free.
    useEffect(() => {
        setPreviewReady(false);
        if (!preview?.previewOriginalData || !preview.previewProcessedData) return;
        const faces: FontFace[] = [];
        try {
            for (const [family, data] of [
                [PREVIEW_FAMILY_ORIGINAL, preview.previewOriginalData],
                [PREVIEW_FAMILY_ECO, preview.previewProcessedData],
            ] as const) {
                const face = new FontFace(family, data);
                if (face.status === "error") throw new Error("font failed to load");
                document.fonts.add(face);
                faces.push(face);
            }
            setPreviewReady(true);
        } catch {
            faces.forEach((face) => document.fonts.delete(face));
            faces.length = 0;
        }
        return () => {
            faces.forEach((face) => document.fonts.delete(face));
        };
    }, [preview]);

    // Pick up files dropped on the landing page (handed over via IndexedDB)
    // and preselect them — processing starts when the user clicks Optimize,
    // so they can pick an Eco Intensity first.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const { takeFiles } = await import("../lib/handoff");
            const handed = await takeFiles();
            if (handed.length > 0 && !cancelled) {
                setFiles(handed);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    function acceptFiles(list: FileList | null | undefined) {
        if (busy) return;
        const candidates = Array.from(list ?? []);
        if (candidates.length === 0) return;
        const { accepted, skipped, error: validationError } = validateSelection(candidates);
        setResults([]);
        setFailures([]);
        setProgress(null);
        if (validationError) {
            setFiles([]);
            setNotice(null);
            setError(validationError);
            return;
        }
        setFiles(accepted);
        setError(null);
        setNotice(
            skipped.length > 0
                ? `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? "" : "s"}: ${skipped
                      .slice(0, 3)
                      .join(", ")}${skipped.length > 3 ? "…" : ""}`
                : null,
        );
    }

    async function runProcess(targets: File[]) {
        if (targets.length === 0) return;
        setBusy(true);
        setError(null);
        setResults([]);
        setFailures([]);
        setProgress(null);
        const collected: EcoResult[] = [];
        const failed: string[] = [];
        try {
            // Loaded on demand: keeps the processing machinery out of the
            // initial bundle and out of the server-side prerender pass. The
            // heavy work itself runs in a Web Worker, so it continues at
            // full speed while the tab is in the background.
            const { processUploadInWorker } = await import("../lib/workerClient");
            const runBatch = async () => {
                for (let i = 0; i < targets.length; i++) {
                    const target = targets[i];
                    trackOptimize(target, intensity);
                    setBatch({ index: i + 1, total: targets.length });
                    setProgress(null);
                    try {
                        collected.push(await processUploadInWorker(target, intensity, setProgress));
                    } catch (err) {
                        failed.push(
                            `${target.name}: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }
            };
            // Holding a Web Lock while the batch runs keeps Chrome from
            // freezing the hidden tab mid-job (frozen pages pause their
            // workers too).
            if (navigator.locks) {
                await navigator.locks.request("ecofonts-optimize", runBatch);
            } else {
                await runBatch();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setResults(collected);
            setFailures(failed);
            setBatch(null);
            setBusy(false);
        }
    }

    function downloadResult(result: EcoResult) {
        const blob = new Blob([result.data], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function downloadAll() {
        for (const result of results) {
            downloadResult(result);
            // Give the browser a beat between programmatic downloads.
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }

    function removePrintFrame() {
        const frame = printFrameRef.current;
        if (!frame) return;
        URL.revokeObjectURL(frame.src);
        frame.remove();
        printFrameRef.current = null;
    }

    // Print the optimized PDF without downloading it: load the blob into an
    // invisible iframe and open the print dialog from the viewer inside it.
    // The frame must be rendered (display:none frames don't print in
    // Firefox) and must outlive the dialog, so it is only removed on the
    // next print or on unmount.
    function printResult(result: EcoResult) {
        removePrintFrame();
        const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }));
        const frame = document.createElement("iframe");
        frame.style.position = "fixed";
        frame.style.right = "0";
        frame.style.bottom = "0";
        frame.style.width = "0";
        frame.style.height = "0";
        frame.style.border = "0";
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        frame.src = url;
        frame.onload = () => {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
        };
        document.body.appendChild(frame);
        printFrameRef.current = frame;
    }

    const totalKb = Math.max(1, Math.round(files.reduce((sum, f) => sum + f.size, 0) / 1024));
    const dropzoneClass = [
        "eco-dropzone",
        dragOver ? "dragover" : "",
        busy ? "disabled" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <main className="eco-main">
            <h1>Optimize your PDFs or fonts</h1>
            <p className="eco-lede">
                Upload <code>.pdf</code> documents and every font embedded in them gets tiny
                ink-saving holes — or optimize <code>.zip</code> font families and{" "}
                <code>.ttf</code>, <code>.otf</code>, <code>.woff</code> or <code>.woff2</code>{" "}
                fonts directly. Everything runs in your browser — files never leave your machine.
            </p>

            <div
                className={dropzoneClass}
                role="button"
                tabIndex={0}
                aria-label="Drop .pdf, .zip or font files here, or press Enter to browse"
                onClick={() => !busy && inputRef.current?.click()}
                onKeyDown={(event) => {
                    if (!busy && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        inputRef.current?.click();
                    }
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(false);
                    acceptFiles(event.dataTransfer.files);
                }}
            >
                <p>
                    <strong>
                        {files.length === 0
                            ? "Drop your PDFs or fonts here"
                            : files.length === 1
                              ? files[0].name
                              : `${files.length} files selected`}
                    </strong>
                </p>
                <p className="eco-hint">
                    {files.length > 0
                        ? `${totalKb} KB — click to change`
                        : ".pdf, .zip, .ttf, .otf, .woff or .woff2 — multiple files welcome"}
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".pdf,.zip,.ttf,.otf,.woff,.woff2"
                    multiple
                    hidden
                    onChange={(event) => acceptFiles(event.target.files)}
                    disabled={busy}
                />
            </div>
            {notice && <p className="eco-notice">{notice}</p>}

            <div className="eco-controls">
                <div className="eco-slider-group">
                    <label htmlFor="eco-intensity">
                        Eco Intensity: <span className="eco-value">{intensity}%</span>
                        <span className="eco-sub">approx. ink area removed</span>
                    </label>
                    <input
                        id="eco-intensity"
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={intensity}
                        onChange={(event) => setIntensity(Number(event.target.value))}
                        disabled={busy}
                    />
                </div>
                <button
                    type="button"
                    className="eco-btn"
                    onClick={() => !busy && runProcess(files)}
                    disabled={files.length === 0 || busy}
                >
                    {busy
                        ? "Processing…"
                        : files.length > 1
                          ? `Optimize ${files.length} files`
                          : "Optimize"}
                </button>
            </div>

            {busy && (
                <div className="eco-progress" aria-live="polite">
                    {batch && batch.total > 1 && (
                        <p>
                            <strong>
                                File {batch.index} of {batch.total}
                            </strong>
                        </p>
                    )}
                    {progress && (
                        <p>
                            Processing {progress.fileName} ({progress.fileIndex}/
                            {progress.fileCount}) — glyph {progress.glyphsDone}/
                            {progress.glyphsTotal}
                        </p>
                    )}
                    <progress
                        value={progress?.glyphsDone ?? 0}
                        max={progress?.glyphsTotal || 1}
                    />
                </div>
            )}

            {error && (
                <div className="eco-error" role="alert">
                    <p>{error}</p>
                </div>
            )}

            {failures.length > 0 && (
                <div className="eco-error" role="alert">
                    <p>
                        {failures.length === 1
                            ? "One file could not be processed:"
                            : `${failures.length} files could not be processed:`}
                    </p>
                    <ul>
                        {failures.map((failure) => (
                            <li key={failure}>{failure}</li>
                        ))}
                    </ul>
                </div>
            )}

            {results.length > 0 && (
                <section className="eco-result">
                    <h2>
                        <span className="eco-check" aria-hidden="true">
                            ✓
                        </span>
                        Your {results.length === 1 ? "file is" : "files are"} ready
                    </h2>
                    <ul className="eco-results-list">
                        {results.map((result, i) => (
                            <li key={`${result.fileName}-${i}`} className="eco-file-row">
                                <div className="eco-file-info">
                                    <strong>{result.fileName}</strong>
                                    <span className="eco-file-meta">
                                        {result.processedFonts.length} font
                                        {result.processedFonts.length === 1 ? "" : "s"} optimized
                                    </span>
                                    {result.warnings.length > 0 && (
                                        <ul className="eco-warnings">
                                            {result.warnings.map((warning) => (
                                                <li key={warning}>{warning}</li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div className="eco-file-actions">
                                    {result.mimeType === "application/pdf" && (
                                        <button
                                            type="button"
                                            className="eco-btn small secondary"
                                            onClick={() => printResult(result)}
                                        >
                                            Print
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="eco-btn small"
                                        onClick={() => downloadResult(result)}
                                    >
                                        Download
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {results.length > 1 && (
                        <div className="eco-download">
                            <button type="button" className="eco-btn" onClick={() => void downloadAll()}>
                                Download all
                            </button>
                        </div>
                    )}

                    {previewReady && (
                        <div className="eco-previews">
                            <label htmlFor="eco-preview-text">Preview text</label>
                            <textarea
                                id="eco-preview-text"
                                className="eco-preview-input"
                                rows={2}
                                value={previewText}
                                placeholder="Type something to compare…"
                                onChange={(event) => setPreviewText(event.target.value)}
                            />
                            <figure>
                                <figcaption>Original</figcaption>
                                <div
                                    className="eco-preview-sample"
                                    style={{ fontFamily: `"${PREVIEW_FAMILY_ORIGINAL}"` }}
                                >
                                    {previewText}
                                </div>
                            </figure>
                            <figure>
                                <figcaption>Ecofont</figcaption>
                                <div
                                    className="eco-preview-sample"
                                    style={{ fontFamily: `"${PREVIEW_FAMILY_ECO}"` }}
                                >
                                    {previewText}
                                </div>
                            </figure>
                        </div>
                    )}
                </section>
            )}
        </main>
    );
}

