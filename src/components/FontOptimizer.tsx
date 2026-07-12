import { useEffect, useRef, useState } from "react";
import type { Font } from "opentype.js";
import type { EcoResult, ProgressInfo } from "../lib/pipeline";

const PREVIEW_TEXT = "Handgloves 0123";

export default function FontOptimizer() {
    const [file, setFile] = useState<File | null>(null);
    const [intensity, setIntensity] = useState(10);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<ProgressInfo | null>(null);
    const [result, setResult] = useState<EcoResult | null>(null);
    const [error, setError] = useState<string | null>(null);
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

    function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
        setFile(event.target.files?.[0] ?? null);
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

    return (
        <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
            <h1>Ecofonts</h1>
            <p>
                Upload a <code>.ttf</code> font or a <code>.zip</code> of fonts. Ecofonts punches
                tiny holes into every glyph so the font prints with less ink. Everything runs in
                your browser — files never leave your machine.
            </p>

            <section>
                <label htmlFor="font-file">Font file (.ttf or .zip)</label>
                <br />
                <input
                    id="font-file"
                    type="file"
                    accept=".ttf,.zip"
                    onChange={handleFileChange}
                    disabled={busy}
                />
                {file && (
                    <p style={{ margin: "8px 0 0", fontSize: 14 }}>
                        Selected: <strong>{file.name}</strong> ({Math.max(1, Math.round(file.size / 1024))} KB)
                    </p>
                )}
            </section>

            <section style={{ marginTop: 16 }}>
                <label htmlFor="eco-intensity">
                    Eco Intensity: <strong>{intensity}%</strong> (approx. ink area removed)
                </label>
                <br />
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
            </section>

            <section style={{ marginTop: 16 }}>
                <button
                    type="button"
                    onClick={() => file && !busy && runProcess(file)}
                    disabled={!file || busy}
                >
                    {busy ? "Processing…" : "Optimize font"}
                </button>
            </section>

            {busy && progress && (
                <section style={{ marginTop: 16 }} aria-live="polite">
                    <p>
                        Processing {progress.fileName} ({progress.fileIndex}/{progress.fileCount})
                        — glyph {progress.glyphsDone}/{progress.glyphsTotal}
                    </p>
                    <progress value={progress.glyphsDone} max={progress.glyphsTotal || 1} />
                </section>
            )}

            {error && (
                <section style={{ marginTop: 16, color: "#b00020" }} role="alert">
                    <p>Error: {error}</p>
                </section>
            )}

            {result && (
                <section style={{ marginTop: 16 }}>
                    <h2>Done</h2>
                    <p>
                        Processed {result.processedFonts.length} font
                        {result.processedFonts.length === 1 ? "" : "s"}:
                    </p>
                    <ul>
                        {result.processedFonts.map((name) => (
                            <li key={name}>{name}</li>
                        ))}
                    </ul>
                    {result.warnings.length > 0 && (
                        <ul style={{ color: "#8a6d00" }}>
                            {result.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                            ))}
                        </ul>
                    )}
                    <button type="button" onClick={handleDownload}>
                        Download {result.fileName}
                    </button>

                    <h3 style={{ marginTop: 16 }}>Preview</h3>
                    <figure style={{ margin: 0 }}>
                        <figcaption>Original</figcaption>
                        <canvas
                            ref={originalCanvasRef}
                            width={600}
                            height={110}
                            style={{ background: "#fff", border: "1px solid #ccc", maxWidth: "100%" }}
                        />
                    </figure>
                    <figure style={{ margin: 0 }}>
                        <figcaption>Ecofont</figcaption>
                        <canvas
                            ref={ecoCanvasRef}
                            width={600}
                            height={110}
                            style={{ background: "#fff", border: "1px solid #ccc", maxWidth: "100%" }}
                        />
                    </figure>
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
