/**
 * File-level pipeline for Ecofonts: routes an upload (single .ttf or a .zip
 * archive) through the geometry engine and repackages the result with the
 * original file names and folder structure intact (including nested folders
 * such as `static/`). Browser-agnostic: ArrayBuffer in, ArrayBuffer out.
 */
import JSZip from "jszip";
import { processTtf } from "./ecofont";

const TTF_RE = /\.ttf$/i;
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
     * on-page preview (loaded as real web fonts via the FontFace API).
     * Only produced by the .ttf/.zip paths — always null for PDFs, which
     * show no font preview (the UI offers Print/Download of the document).
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
    if (TTF_RE.test(fileName)) return processSingleTtf(fileName, data, intensity, onProgress);
    if (PDF_RE.test(fileName)) return processPdfUpload(fileName, data, intensity, onProgress);
    throw new Error(
        "Unsupported file type — upload a .ttf font, a .zip archive, or a .pdf document.",
    );
}

async function processSingleTtf(
    fileName: string,
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    const { buffer, droppedVariations } = await processTtf(
        data,
        intensity,
        (glyphsDone, glyphsTotal) =>
            onProgress?.({ fileName, fileIndex: 1, fileCount: 1, glyphsDone, glyphsTotal }),
    );
    return {
        fileName,
        mimeType: "application/x-font-ttf",
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
        (entry) => !entry.dir && TTF_RE.test(entry.name),
    );
    if (entries.length === 0) {
        throw new Error("The .zip archive contains no .ttf files.");
    }

    const processedFonts: string[] = [];
    const warnings: string[] = [];
    let previewOriginalData: ArrayBuffer | null = null;
    let previewProcessedData: ArrayBuffer | null = null;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const original = await entry.async("arraybuffer");
        try {
            const { buffer, droppedVariations } = await processTtf(
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
