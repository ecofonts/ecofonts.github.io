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
import { extractTtcFace } from "./webfont";

interface LocalFontData {
    postscriptName: string;
    fullName: string;
    family: string;
    style: string;
    blob(): Promise<Blob>;
}

/**
 * Collapse a font identifier to a comparison key: lower-case, stripped of a
 * six-letter subset prefix ("ABCDEF+…") and of every separator, so
 * "Times New Roman,Italic", "TimesNewRoman-Italic" and "Times New Roman Italic"
 * all fold to the same key. PDF descriptors name non-embedded fonts by their
 * human family (Word writes "Family,Style"), while the Local Font Access API
 * keys them by PostScript name — matching only works once both are normalized.
 */
function normalizeName(name: string): string {
    return name
        .replace(/^[A-Z]{6}\+/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

const STYLE_WORDS = /(regular|italic|oblique|bold|black|heavy|light|medium|semibold|demibold|thin|book|roman|normal)/gi;

/**
 * Build a lookup keyed by every reasonable spelling of an installed font, so a
 * request phrased as a family name or a "Family,Style" pair still finds the
 * right face. Regular faces additionally claim the bare family key so a
 * style-less request ("Arial") resolves to the regular weight.
 */
function buildIndex(fonts: LocalFontData[]): Map<string, LocalFontData> {
    const index = new Map<string, LocalFontData>();
    const claim = (key: string, font: LocalFontData, override = false) => {
        if (!key) return;
        if (override || !index.has(key)) index.set(key, font);
    };
    for (const font of fonts) {
        claim(normalizeName(font.postscriptName), font, true);
        claim(normalizeName(font.fullName), font);
        claim(normalizeName(`${font.family}${font.style}`), font);
        const isRegular = /^(regular|normal|book|roman|)$/i.test(font.style.trim());
        // "Arial" (no style) → the regular face, not whichever came first.
        if (isRegular) claim(normalizeName(font.family), font, true);
    }
    return index;
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
    const index = buildIndex(fonts);
    const match = (requested: string): LocalFontData | undefined => {
        const direct = index.get(normalizeName(requested));
        if (direct) return direct;
        // Fall back to the bare family (drop style words) so an unusual style
        // spelling still lands on the regular face rather than nothing.
        const family = normalizeName(requested.replace(/^[A-Z]{6}\+/, "").replace(STYLE_WORDS, ""));
        return index.get(family);
    };
    return async (requestedNames) => {
        const out: Record<string, ArrayBuffer> = {};
        for (const name of requestedNames) {
            const font = match(name);
            if (!font) continue;
            try {
                const data = await (await font.blob()).arrayBuffer();
                // The API hands back the underlying file, which for several
                // system fonts is a collection — extract the matched face
                // (by its real PostScript name, not the requested alias).
                const face = extractTtcFace(data, font.postscriptName);
                out[name] = face ?? data;
            } catch {
                // A font we can't read is the same as a font we don't have.
            }
        }
        return out;
    };
}
