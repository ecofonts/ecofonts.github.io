/**
 * File-level pipeline for Ecofonts: routes an upload (a single font, a .zip
 * archive, or a .pdf) through the geometry engine and repackages the result
 * with the original file names and folder structure intact (including
 * nested folders such as `static/`). Fonts are accepted in any container —
 * plain sfnt (.ttf/.otf) or compressed web font (.woff/.woff2) — and come
 * back in the container they arrived in. Browser-agnostic: ArrayBuffer in,
 * ArrayBuffer out.
 */
import JSZip from "jszip";
import { processTtf } from "./ecofont";
import { compressWoff2, decompressWoff2, sniffContainer, wrapWoff } from "./webfont";
import type { GlyphProgressCallback } from "./ecofont";

const FONT_RE = /\.(ttf|otf|woff2?)$/i;
const ZIP_RE = /\.zip$/i;
const PDF_RE = /\.pdf$/i;

export interface ProgressInfo {
    /** Name (zip-relative path) of the font currently being processed. */
    fileName: string;
    /** 1-based index of the current font file. */
    fileIndex: number;
    /** Total number of font files to process. */
    fileCount: number;
    glyphsDone: number;
    glyphsTotal: number;
}
export type ProgressCallback = (info: ProgressInfo) => void;

export interface EcoResult {
    /** Download name — identical to the uploaded file's name. */
    fileName: string;
    mimeType: string;
    data: ArrayBuffer;
    /** Paths of the fonts that were successfully processed. */
    processedFonts: string[];
    /** Per-file failures (those files are passed through unmodified). */
    warnings: string[];
    /**
     * Raw font bytes of the first processed font, before/after, for the
     * on-page preview (loaded as real web fonts via the FontFace API, which
     * accepts sfnt, WOFF and WOFF2 buffers alike). Only produced by the
     * font/.zip paths — always null for PDFs, which show no font preview
     * (the UI offers Print/Download of the document).
     */
    previewOriginalData: ArrayBuffer | null;
    previewProcessedData: ArrayBuffer | null;
}

/**
 * @param intensityPercent slider value, 1–20 (% of interior ink to remove)
 */
export async function processUpload(
    fileName: string,
    data: ArrayBuffer,
    intensityPercent: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    const intensity = Math.min(Math.max(intensityPercent, 1), 20) / 100;
    if (ZIP_RE.test(fileName)) return processZip(fileName, data, intensity, onProgress);
    if (FONT_RE.test(fileName)) return processSingleFont(fileName, data, intensity, onProgress);
    if (PDF_RE.test(fileName)) return processPdfUpload(fileName, data, intensity, onProgress);
    throw new Error(
        "Unsupported file type — upload a .pdf document, a .zip archive, or a font (.ttf, .otf, .woff, .woff2).",
    );
}

/**
 * Punch eco holes into one font binary, whatever its container: WOFF2 is
 * unwrapped to a plain sfnt for the geometry engine (WOFF needs no
 * unwrapping — opentype.js reads the container natively) and the result is
 * re-wrapped, so the output keeps the container the input arrived in.
 * Routing is by byte signature, not extension — a mislabeled file keeps
 * whatever container it really had.
 */
async function processFontData(
    data: ArrayBuffer,
    intensity: number,
    onGlyph?: GlyphProgressCallback,
): Promise<{ buffer: ArrayBuffer; droppedVariations: boolean }> {
    const container = sniffContainer(data);
    const input = container === "woff2" ? await decompressWoff2(data) : data;
    const { buffer, droppedVariations } = await processTtf(input, intensity, onGlyph);
    if (container === "woff") return { buffer: await wrapWoff(buffer), droppedVariations };
    if (container === "woff2") return { buffer: await compressWoff2(buffer), droppedVariations };
    return { buffer, droppedVariations };
}

function fontMimeType(fileName: string): string {
    if (/\.otf$/i.test(fileName)) return "font/otf";
    if (/\.woff$/i.test(fileName)) return "font/woff";
    if (/\.woff2$/i.test(fileName)) return "font/woff2";
    return "application/x-font-ttf";
}

async function processSingleFont(
    fileName: string,
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    const { buffer, droppedVariations } = await processFontData(
        data,
        intensity,
        (glyphsDone, glyphsTotal) =>
            onProgress?.({ fileName, fileIndex: 1, fileCount: 1, glyphsDone, glyphsTotal }),
    );
    return {
        fileName,
        mimeType: fontMimeType(fileName),
        data: buffer,
        processedFonts: [fileName],
        warnings: droppedVariations ? [variableFontWarning(fileName)] : [],
        previewOriginalData: data,
        // The actual output bytes: the preview shows exactly the download.
        previewProcessedData: buffer,
    };
}

async function processZip(
    fileName: string,
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    const zip = await JSZip.loadAsync(data);
    const entries = Object.values(zip.files).filter(
        (entry) => !entry.dir && FONT_RE.test(entry.name),
    );
    if (entries.length === 0) {
        throw new Error("The .zip archive contains no font files (.ttf, .otf, .woff, .woff2).");
    }

    const processedFonts: string[] = [];
    const warnings: string[] = [];
    let previewOriginalData: ArrayBuffer | null = null;
    let previewProcessedData: ArrayBuffer | null = null;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const original = await entry.async("arraybuffer");
        try {
            const { buffer, droppedVariations } = await processFontData(
                original,
                intensity,
                (done, total) =>
                    onProgress?.({
                        fileName: entry.name,
                        fileIndex: i + 1,
                        fileCount: entries.length,
                        glyphsDone: done,
                        glyphsTotal: total,
                    }),
            );
            // Re-adding under the same path replaces the entry in place, so
            // the archive keeps its exact structure; non-font files (licenses,
            // variable-font originals, etc.) pass through untouched.
            zip.file(entry.name, buffer);
            processedFonts.push(entry.name);
            if (droppedVariations) warnings.push(variableFontWarning(entry.name));
            if (!previewProcessedData) {
                previewProcessedData = buffer;
                previewOriginalData = original;
            }
        } catch (err) {
            warnings.push(`${entry.name}: ${errorMessage(err)} — kept unmodified`);
        }
    }

    if (processedFonts.length === 0) {
        throw new Error(`Could not process any font in the archive. ${warnings.join(" / ")}`);
    }

    const out = await zip.generateAsync({
        type: "arraybuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });
    return {
        fileName,
        mimeType: "application/zip",
        data: out,
        processedFonts,
        warnings,
        previewOriginalData,
        previewProcessedData,
    };
}

async function processPdfUpload(
    fileName: string,
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    // pdf-lib is sizable — load it only when a PDF actually arrives.
    const { processPdf } = await import("./pdf");
    const result = await processPdf(data, intensity, onProgress);
    return {
        fileName,
        mimeType: "application/pdf",
        data: result.data,
        processedFonts: result.processedFonts,
        warnings: result.warnings,
        previewOriginalData: null,
        previewProcessedData: null,
    };
}

function variableFontWarning(name: string): string {
    return `${name}: variable font — the output contains only the default (static) instance`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
