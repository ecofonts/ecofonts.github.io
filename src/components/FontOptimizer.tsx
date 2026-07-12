import { useEffect, useRef, useState } from "react";
import type { Font } from "opentype.js";
import type { EcoResult, ProgressInfo } from "../lib/pipeline";
import "./FontOptimizer.css";

const PREVIEW_TEXT = "Handgloves 0123";
const ACCEPTED_RE = /\.(ttf|zip|pdf)$/i;

export default function FontOptimizer() {
    const [file, setFile] = useState<File | null>(null);
    const [intensity, setIntensity] = useState(10);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [progress, setProgress] = useState<ProgressInfo | null>(null);
    const [result, setResult] = useState<EcoResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const originalCanvasRef = useRef<HTMLCanvasElement>(null);
    const ecoCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        drawPreview(result?.previewOriginal ?? null, originalCanvasRef.current);
        drawPreview(result?.previewProcessed ?? null, ecoCanvasRef.current);
    }, [result]);

    // Pick up a file dropped on the landing page (handed over via IndexedDB)
    // and start processing it right away.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const { takeFile } = await import("../lib/handoff");
            const handed = await takeFile();
            if (handed && !cancelled) {
                setFile(handed);
                void runProcess(handed);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    function acceptFile(candidate: File | undefined) {
        if (busy) return;
        if (!candidate || !ACCEPTED_RE.test(candidate.name)) {
            setError("Please choose a .pdf document, a .zip archive, or a .ttf font.");
            return;
        }
        setFile(candidate);
        setResult(null);
        setError(null);
        setProgress(null);
    }

    async function runProcess(target: File) {
        setBusy(true);
        setError(null);
        setResult(null);
        setProgress(null);
        try {
            // Loaded on demand: keeps opentype.js/clipper/jszip out of the
            // initial bundle and out of the server-side prerender pass.
            const { processUpload } = await import("../lib/pipeline");
            const data = await target.arrayBuffer();
            setResult(await processUpload(target.name, data, intensity, setProgress));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function handleDownload() {
        if (!result) return;
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

    const dropzoneClass = [
        "eco-dropzone",
        dragOver ? "dragover" : "",
        busy ? "disabled" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <main className="eco-main">
            <h1>Optimize your PDF or font</h1>
            <p className="eco-lede">
                Upload a <code>.pdf</code> document and every font embedded in it gets tiny
                ink-saving holes — or optimize a <code>.zip</code> font family or a single{" "}
                <code>.ttf</code> directly. Everything runs in your browser — files never leave
                your machine.
            </p>

            <div
                className={dropzoneClass}
                role="button"
                tabIndex={0}
                aria-label="Drop a .pdf, .zip or .ttf file here, or press Enter to browse"
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
                    acceptFile(event.dataTransfer.files?.[0]);
                }}
            >
                <p>
                    <strong>{file ? file.name : "Drop your PDF or font here"}</strong>
                </p>
                <p className="eco-hint">
                    {file
                        ? `${Math.max(1, Math.round(file.size / 1024))} KB — click to change`
                        : ".pdf, .zip or .ttf — or click to browse"}
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".pdf,.zip,.ttf"
                    hidden
                    onChange={(event) => acceptFile(event.target.files?.[0])}
                    disabled={busy}
                />
            </div>

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
                    onClick={() => file && !busy && runProcess(file)}
                    disabled={!file || busy}
                >
                    {busy ? "Processing…" : "Optimize font"}
                </button>
            </div>

            {busy && progress && (
                <div className="eco-progress" aria-live="polite">
                    <p>
                        Processing {progress.fileName} ({progress.fileIndex}/{progress.fileCount})
                        — glyph {progress.glyphsDone}/{progress.glyphsTotal}
                    </p>
                    <progress value={progress.glyphsDone} max={progress.glyphsTotal || 1} />
                </div>
            )}

            {error && (
                <div className="eco-error" role="alert">
                    <p>{error}</p>
                </div>
            )}

            {result && (
                <section className="eco-result">
                    <h2>
                        <span className="eco-check" aria-hidden="true">
                            ✓
                        </span>
                        Your ecofont is ready
                    </h2>
                    <p>
                        Processed {result.processedFonts.length} font
                        {result.processedFonts.length === 1 ? "" : "s"}:
                    </p>
                    <ul className="eco-list">
                        {result.processedFonts.map((name) => (
                            <li key={name}>{name}</li>
                        ))}
                    </ul>
                    {result.warnings.length > 0 && (
                        <ul className="eco-warnings">
                            {result.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                            ))}
                        </ul>
                    )}
                    <div className="eco-download">
                        <button type="button" className="eco-btn" onClick={handleDownload}>
                            Download {result.fileName}
                        </button>
                    </div>

                    {result.previewProcessed && (
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
