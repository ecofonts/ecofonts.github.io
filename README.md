<p align="center">
  <img src="public/favicon.svg" alt="Ecofonts logo" width="96" height="96" />
</p>

<h1 align="center">Ecofonts</h1>

<p align="center"><strong>Save Ink, Save the planet.</strong></p>

Ecofonts is a 100% client-side font optimizer. It punches a grid of microscopic
vector holes ("eco holes") into the interior of every glyph so your documents
print with less ink — up to 20% less — while staying crisp and legible at
reading sizes. Everything runs in your browser: **no uploads, no servers, no
accounts. Your files never leave your machine.**

## What it does

Upload any of the following and download the optimized result with the same
name and structure:

| Input  | What happens                                                                                                               |
| :----- | :------------------------------------------------------------------------------------------------------------------------- |
| `.ttf` | The font's glyphs get eco holes and the font is re-compiled.                                                                 |
| `.zip` | Every `.ttf` inside is optimized (nested folders like Google Fonts' `static/` included); other files pass through untouched. |
| `.pdf` | Every embedded font — TrueType, CFF/OpenType, and legacy Type 1 — is rewritten in place; layout and selectable text stay identical. |

An **Eco Intensity** slider (1–20%) controls how much ink is removed, and it's
honest: the value maps to the measured share of glyph area actually subtracted.
A minimum "wall" of ink is always preserved around every hole, so letter
silhouettes are never notched and thin strokes keep their edges.

## Getting started

Requires Node.js ≥ 22.12.

```sh
npm install
npm run dev       # dev server at http://localhost:4321
npm run build     # production build to ./dist/
npm run preview   # preview the production build
```

Routes:

- `/` — landing page with a drag-and-drop zone (drops are handed to the
  optimizer via IndexedDB and preselected there — pick an Eco Intensity and
  click Optimize).
- `/font` — the optimizer itself.

## How it works

1. **Parse** — glyph outlines are read with [opentype.js](https://github.com/opentypejs/opentype.js)
   (or, for PDF-embedded fonts, directly from the font binary by
   format-specific parsers).
2. **Flatten** — Bézier curves are subdivided into polygons in integer font
   units.
3. **Subtract** — a globally aligned, staggered grid of octagonal holes is
   clipped against an inset of the glyph interior and subtracted with boolean
   geometry ([clipper-lib](https://sourceforge.net/projects/jsclipper/)). The
   inset guarantees a minimum wall thickness so outlines stay intact.
4. **Re-compile** — new outlines are written back into a working font binary;
   ZIP archives are rebuilt with [JSZip](https://stuk.github.io/jszip/) and
   PDFs with [pdf-lib](https://pdf-lib.js.org/), preserving structure exactly.

For PDFs, purpose-built binary "surgeons" rewrite only the outline data and
keep every other byte of the font — glyph IDs, widths, encodings, and hinting
of untouched glyphs — exactly as the document expects, which is what makes
subset fonts without cmap/name tables work:
[src/lib/glyf.ts](src/lib/glyf.ts) patches the `glyf`/`loca` tables of
TrueType fonts, [src/lib/cff.ts](src/lib/cff.ts) re-emits the Type 2
charstrings of CFF/OpenType fonts, and [src/lib/type1.ts](src/lib/type1.ts)
splices new charstrings into decrypted legacy Type 1 fonts.

## Tech stack

- [Astro](https://astro.build) (static output) + [React](https://react.dev)
  via `@astrojs/react` for the optimizer UI
- `opentype.js` · `clipper-lib` · `jszip` · `pdf-lib` — all loaded on demand,
  so the initial page stays light
- No backend of any kind — the site deploys as plain static files

## Known limitations

- `.ttf`/`.zip` output is CFF-flavored OpenType (an opentype.js constraint);
  it installs and renders everywhere and keeps the `.ttf` name.
- Ligatures (GSUB) and variation axes are dropped from re-compiled fonts;
  variable fonts come back as their default instance (upload the family ZIP
  to keep all weights).
- In PDFs, all embedded font formats are rewritten — TrueType (`FontFile2`),
  CFF/OpenType (`FontFile3`), and legacy Type 1 (`FontFile`). Only text drawn
  with non-embedded viewer fonts cannot be optimized.
- Optimized files are larger than the originals (curves become line
  segments); that's inherent to the approach.

## License note

Ecofonts modifies fonts locally and never redistributes anything, but whether
*you* may modify a given font depends on its license. Open licenses such as the
SIL Open Font License explicitly allow modification; for commercial fonts,
check your license terms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
