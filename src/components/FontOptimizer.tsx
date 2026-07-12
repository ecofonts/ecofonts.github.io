import { useEffect, useRef, useState } from "react";
import type { Font } from "opentype.js";
import type { EcoResult, ProgressInfo } from "../lib/pipeline";
import { validateSelection } from "../lib/limits";
import "./FontOptimizer.css";

const PREVIEW_TEXT = "Handgloves 0123";

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
    const inputRef = useRef<HTMLInputElement>(null);
    const originalCanvasRef = useRef<HTMLCanvasElement>(null);
    const ecoCanvasRef = useRef<HTMLCanvasElement>(null);

    const preview = results.find((result) => result.previewProcessed) ?? null;

    useEffect(() => {
        drawPreview(preview?.previewOriginal ?? null, originalCanvasRef.current);
        drawPreview(preview?.previewProcessed ?? null, ecoCanvasRef.current);
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
            // Loaded on demand: keeps the processing libraries out of the
            // initial bundle and out of the server-side prerender pass.
            const { processUpload } = await import("../lib/pipeline");
            for (let i = 0; i < targets.length; i++) {
                const target = targets[i];
                setBatch({ index: i + 1, total: targets.length });
                setProgress(null);
                try {
                    const data = await target.arrayBuffer();
                    collected.push(await processUpload(target.name, data, intensity, setProgress));
                } catch (err) {
                    failed.push(
                        `${target.name}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
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
                <code>.ttf</code> fonts directly. Everything runs in your browser — files never
                leave your machine.
            </p>

            <div
                className={dropzoneClass}
                role="button"
                tabIndex={0}
                aria-label="Drop .pdf, .zip or .ttf files here, or press Enter to browse"
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
                        : ".pdf, .zip or .ttf — multiple files welcome"}
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".pdf,.zip,.ttf"
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
                                <button
                                    type="button"
                                    className="eco-btn small"
                                    onClick={() => downloadResult(result)}
                                >
                                    Download
                                </button>
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

                    {preview && (
                        <div className="eco-previews">
                            <figure>
                                <figcaption>Original</figcaption>
                                <canvas ref={originalCanvasRef} width={600} height={110} />
                            </figure>
                            <figure>
                                <figcaption>Ecofont</figcaption>
                                <canvas ref={ecoCanvasRef} width={600} height={110} />
                            </figure>
                        </div>
                    )}
                </section>
            )}
        </main>
    );
}

function drawPreview(font: Font | null, canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!font) return;
    try {
        font.draw(ctx, PREVIEW_TEXT, 10, 82, 72);
    } catch {
        // A preview failure should never block the download.
    }
}
