/**
 * File-level pipeline for Ecofonts: routes an upload (single .ttf or a .zip
 * archive) through the geometry engine and repackages the result with the
 * original file names and folder structure intact (including nested folders
 * such as `static/`). Browser-agnostic: ArrayBuffer in, ArrayBuffer out.
 */
import JSZip from "jszip";
import type { Font } from "opentype.js";
import { parseFont, processTtf } from "./ecofont";

const TTF_RE = /\.ttf$/i;
const ZIP_RE = /\.zip$/i;

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
    /** First processed font, before/after, for rendering a preview. */
    previewOriginal: Font | null;
    previewProcessed: Font | null;
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
    throw new Error("Unsupported file type — upload a .ttf font or a .zip archive.");
}

async function processSingleTtf(
    fileName: string,
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<EcoResult> {
    const { buffer, font, droppedVariations } = await processTtf(
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
        previewOriginal: safeParse(data),
        previewProcessed: font,
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
    let previewOriginal: Font | null = null;
    let previewProcessed: Font | null = null;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const original = await entry.async("arraybuffer");
        try {
            const { buffer, font, droppedVariations } = await processTtf(
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
            if (!previewProcessed) {
                previewProcessed = font;
                previewOriginal = safeParse(original);
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
        previewOriginal,
        previewProcessed,
    };
}

function variableFontWarning(name: string): string {
    return `${name}: variable font — the output contains only the default (static) instance`;
}

function safeParse(data: ArrayBuffer): Font | null {
    try {
        return parseFont(data);
    } catch {
        return null;
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
