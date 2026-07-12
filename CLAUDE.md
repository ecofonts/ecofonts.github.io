# Ecofonts

A 100% client-side font optimizer. Users upload a `.ttf` file or a `.zip` of
fonts; Ecofonts subtracts a grid of small vector holes ("eco holes") from the
interior of every glyph so the font prints with less ink, then returns the
modified file for download. No font data ever leaves the browser.

## Architecture

- **Framework:** Astro (static output) + `@astrojs/react`.
- **Routes:**
  - `/` — [src/pages/index.astro](src/pages/index.astro): intentionally blank landing page (stub).
  - `/font` — [src/pages/font.astro](src/pages/font.astro): mounts the optimizer React component with `client:load`.
- **Strictly client-side processing.** There are no API routes, server
  endpoints, or serverless functions — all parsing, geometry, and packaging
  runs in the browser. Keep it that way.

### Source layout

- [src/components/FontOptimizer.tsx](src/components/FontOptimizer.tsx) — UI: file input (`.ttf`/`.zip`),
  "Eco Intensity" slider (1–20%), progress display, before/after canvas
  preview, blob download. Loads the pipeline with a dynamic `import()` on
  first use — this keeps the heavy libraries out of the initial bundle **and
  out of Astro's prerender pass** (see gotchas).
- [src/lib/pipeline.ts](src/lib/pipeline.ts) — file-level routing: single `.ttf` vs `.zip`
  traversal with JSZip. Rewrites zip entries in place so the archive keeps
  its exact folder structure (e.g. Google Fonts `static/` folders); non-font
  files pass through untouched; per-file failures become warnings and the
  original file is kept.
- [src/lib/ecofont.ts](src/lib/ecofont.ts) — geometry engine: opentype.js parse → flatten
  glyph outlines to polygons → boolean ops with clipper-lib → new paths →
  `font.toArrayBuffer()`. Browser-agnostic (ArrayBuffer in/out, no DOM), so
  it can be exercised from Node for testing.
- [src/lib/clipper-lib.d.ts](src/lib/clipper-lib.d.ts) — hand-written types for the parts of
  `clipper-lib` we use (the package ships none).

### Processing pipeline (per glyph)

1. Snapshot **all** glyph paths before mutating any — composite glyphs
   (accents) resolve component outlines lazily.
2. Flatten M/L/Q/C/Z commands to polygons (Clipper needs integers; font units
   are scaled by 100).
3. Union with the nonzero fill rule to normalize winding.
4. Inset the shape by a minimum "wall" thickness (ClipperOffset, negative
   delta) so holes never notch the glyph silhouette.
5. Intersect a globally-aligned staggered grid of octagonal holes with the
   inset interior, then subtract the result from the full glyph.
6. If no holes fit (thin glyph, empty inset), keep the original curved path.

Hole radius is solved from the slider value so the *measured* ink-area
reduction tracks the chosen percentage (a calibration factor compensates for
area the wall protection preserves). Tuning constants live at the top of
[src/lib/ecofont.ts](src/lib/ecofont.ts).

## Known limitations / gotchas

- **opentype.js writes CFF-flavored OpenType** (`OTTO` sfnt), not glyf-based
  TrueType. The output installs and renders everywhere; original filenames
  and extensions are preserved.
- **GSUB is dropped** before writing: opentype.js throws on GSUB lookup
  types it can't serialize (e.g. type 7 in Arial). Ligatures and similar
  optional substitutions are lost; outlines and metrics are unaffected.
- **Never statically import opentype.js from component code.** Astro's
  prerender pass loads modules in plain Node, where opentype.js resolves as
  CJS and its named ESM imports crash the build (`vite.ssr.noExternal` does
  not help the prerender chunks). Reach it through the dynamically imported
  pipeline instead.
- Variable fonts lose their variation tables (opentype.js rewrites only the
  default instance); the static instances usually shipped alongside them
  process fine.
- Output files grow (curves become line segments); that is inherent to the
  approach.

## Testing

There is no test runner wired up yet. The lib layer is deliberately
DOM-free: bundle a scratch script with the repo's own esbuild
(`node_modules\.bin\esbuild.cmd entry.mjs --bundle --platform=node
--format=esm`) and run it in Node against a system font (e.g.
`C:\Windows\Fonts\arial.ttf`) to exercise parse → holes → re-compile →
re-parse round trips.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
