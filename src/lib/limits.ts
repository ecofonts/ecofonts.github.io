/**
 * Single source of truth for what an upload selection may contain — used by
 * both the landing drop zone and the optimizer component so the two can
 * never drift apart.
 *
 * The per-type maximums are deliberately not surfaced in regular UI copy;
 * they only appear in the error message when a selection exceeds them.
 */

export const ACCEPTED_RE = /\.(ttf|otf|woff2?|zip|pdf)$/i;

export const MAX_FILES = {
    pdf: 20,
    /** All standalone font formats (.ttf, .otf, .woff, .woff2) combined. */
    font: 100,
    zip: 5,
} as const;

export interface SelectionResult<T> {
    /** Files that passed validation (empty when `error` is set). */
    accepted: T[];
    /** Names of files skipped for having an unsupported extension. */
    skipped: string[];
    /** Set when the whole selection must be rejected. */
    error: string | null;
}

export function validateSelection<T extends { name: string }>(files: T[]): SelectionResult<T> {
    const accepted: T[] = [];
    const skipped: string[] = [];
    const counts = { pdf: 0, font: 0, zip: 0 };

    for (const file of files) {
        const match = ACCEPTED_RE.exec(file.name);
        if (!match) {
            skipped.push(file.name);
            continue;
        }
        accepted.push(file);
        const ext = match[1].toLowerCase();
        counts[ext === "pdf" || ext === "zip" ? ext : "font"]++;
    }

    if (accepted.length === 0) {
        return {
            accepted: [],
            skipped,
            error: "Please choose .pdf documents, .zip archives, or fonts (.ttf, .otf, .woff, .woff2).",
        };
    }

    const over: string[] = [];
    if (counts.pdf > MAX_FILES.pdf) over.push(`${MAX_FILES.pdf} PDF documents`);
    if (counts.font > MAX_FILES.font) over.push(`${MAX_FILES.font} fonts`);
    if (counts.zip > MAX_FILES.zip) over.push(`${MAX_FILES.zip} .zip archives`);
    if (over.length > 0) {
        return {
            accepted: [],
            skipped,
            error: `Too many files — you can process up to ${over.join(" and ")} at once.`,
        };
    }

    return { accepted, skipped, error: null };
}
