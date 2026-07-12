/**
 * PDF pipeline: extracts every embedded TrueType font program (FontFile2
 * stream), runs it through the glyf surgeon, and re-embeds it in place.
 * Nothing else in the document is touched — text, layout, images, metadata
 * and page content streams stay byte-identical in meaning.
 *
 * Fonts embedded in other formats (FontFile = Type 1, FontFile3 = CFF)
 * cannot be rewritten by this tool yet and are kept as-is with a warning.
 */
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFRef,
    decodePDFRawStream,
} from "pdf-lib";
import { ecoProcessTrueType } from "./glyf";
import type { ProgressCallback } from "./pipeline";

export interface PdfEcoOutput {
    data: ArrayBuffer;
    processedFonts: string[];
    warnings: string[];
}

export async function processPdf(
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
): Promise<PdfEcoOutput> {
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not read the PDF: ${message}`);
    }

    // Collect the unique TrueType font streams referenced by font
    // descriptors (the same stream may be shared by several descriptors).
    const targets: { ref: PDFRef; name: string }[] = [];
    const seenRefs = new Set<string>();
    let otherFormats = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        const fontFile2 = obj.get(PDFName.of("FontFile2"));
        if (fontFile2 instanceof PDFRef) {
            if (!seenRefs.has(fontFile2.tag)) {
                seenRefs.add(fontFile2.tag);
                targets.push({ ref: fontFile2, name: descriptorFontName(obj) });
            }
        } else if (
            obj.get(PDFName.of("FontFile")) instanceof PDFRef ||
            obj.get(PDFName.of("FontFile3")) instanceof PDFRef
        ) {
            otherFormats++;
        }
    }

    if (targets.length === 0) {
        if (otherFormats > 0) {
            throw new Error(
                "This PDF only embeds fonts in formats Ecofonts cannot rewrite yet (Type 1/CFF) — no TrueType fonts found.",
            );
        }
        throw new Error(
            "No embedded fonts found in this PDF — the text may use standard viewer fonts, which cannot be optimized.",
        );
    }

    const processedFonts: string[] = [];
    const warnings: string[] = [];
    if (otherFormats > 0) {
        warnings.push(
            `${otherFormats} font${otherFormats === 1 ? "" : "s"} embedded in Type 1/CFF format — kept as-is`,
        );
    }

    for (let i = 0; i < targets.length; i++) {
        const { ref, name } = targets[i];
        try {
            const stream = doc.context.lookup(ref);
            if (!(stream instanceof PDFRawStream)) {
                throw new Error("font stream has an unexpected object type");
            }
            const fontBytes = decodePDFRawStream(stream).decode();
            const { buffer } = await ecoProcessTrueType(fontBytes, intensity, (done, total) =>
                onProgress?.({
                    fileName: name,
                    fileIndex: i + 1,
                    fileCount: targets.length,
                    glyphsDone: done,
                    glyphsTotal: total,
                }),
            );
            const newBytes = new Uint8Array(buffer);
            const newStream = doc.context.flateStream(newBytes);
            // FontFile2 requires Length1 = uncompressed font program size.
            newStream.dict.set(PDFName.of("Length1"), PDFNumber.of(newBytes.length));
            doc.context.assign(ref, newStream);
            processedFonts.push(name);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push(`${name}: ${message} — kept as-is`);
        }
    }

    if (processedFonts.length === 0) {
        throw new Error(`Could not process any font in the PDF. ${warnings.join(" / ")}`);
    }

    const saved = await doc.save({ useObjectStreams: false });
    // Copy into a fresh buffer: saved.buffer is typed ArrayBufferLike and may
    // be a view into a larger allocation.
    const out = new Uint8Array(saved.byteLength);
    out.set(saved);
    return { data: out.buffer, processedFonts, warnings };
}

function descriptorFontName(descriptor: PDFDict): string {
    const name = descriptor.get(PDFName.of("FontName"));
    if (name instanceof PDFName) return name.decodeText();
    return "embedded font";
}
