/**
 * Local Font Access API (Chromium-only) helper. PDFs frequently reference
 * fonts without embedding them — Word exports in particular leave standard
 * system fonts (Arial, Times New Roman, …) out of the file — and text drawn
 * with such fonts has no outlines in the document for the pipeline to
 * optimize. With the user's permission, `queryLocalFonts()` hands us the
 * bytes of the fonts installed on their machine, so the pipeline can
 * optimize the *installed* copy and embed it into the PDF.
 *
 * Main-thread only: the API does not exist in workers and its permission
 * prompt requires transient user activation, so `requestLocalFonts` must be
 * called directly from the Optimize click handler. The returned resolver is
 * then safe to call at any later time (e.g. when the worker asks for fonts
 * mid-job).
 */
import type { LocalFontResolver } from "./pipeline";

interface LocalFontData {
    postscriptName: string;
    fullName: string;
    family: string;
    style: string;
    blob(): Promise<Blob>;
}

declare global {
    interface Window {
        queryLocalFonts?: (options?: {
            postscriptNames?: string[];
        }) => Promise<LocalFontData[]>;
    }
}

/**
 * Ask for access to the user's installed fonts. Returns null when the API
 * is unavailable (non-Chromium browsers) or the user declines — the PDF
 * pipeline then simply reports non-embedded fonts as warnings.
 */
export async function requestLocalFonts(): Promise<LocalFontResolver | null> {
    if (typeof window === "undefined" || typeof window.queryLocalFonts !== "function") {
        return null;
    }
    let fonts: LocalFontData[];
    try {
        fonts = await window.queryLocalFonts();
    } catch {
        // Permission denied, dismissed, or blocked by policy.
        return null;
    }
    const byName = new Map(fonts.map((font) => [font.postscriptName, font]));
    return async (postscriptNames) => {
        const out: Record<string, ArrayBuffer> = {};
        for (const name of postscriptNames) {
            const font = byName.get(name);
            if (!font) continue;
            try {
                out[name] = await (await font.blob()).arrayBuffer();
            } catch {
                // A font we can't read is the same as a font we don't have.
            }
        }
        return out;
    };
}
