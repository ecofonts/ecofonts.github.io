# Contributing to Ecofonts

Thanks for your interest in improving Ecofonts! Contributions of all kinds are
welcome — bug reports, fixes, features, documentation, and design.

## Getting set up

1. Fork and clone the repository.
2. Install dependencies (Node.js ≥ 22.12 required):

   ```sh
   npm install
   ```

3. Start the dev server:

   ```sh
   npm run dev
   ```

   The site runs at `http://localhost:4321` (landing page at `/`, optimizer at
   `/font`).

## Project ground rules

- **Everything stays client-side.** Ecofonts' core promise is that user files
  never leave the browser. Do not add API routes, server endpoints, or any
  network calls that transmit font/PDF data.
- **Heavy libraries load on demand.** The processing libraries (opentype.js,
  clipper-lib, jszip, pdf-lib) are reached through dynamic `import()` so the
  initial page stays light and Astro's prerender pass never loads them. Keep
  new dependencies behind the same pattern.
- **Preserve user files faithfully.** Output must keep original filenames,
  ZIP folder structures, PDF layout, glyph IDs, and metrics. When something
  can't be processed, pass it through unchanged and surface a warning rather
  than failing the whole job.
- See [CLAUDE.md](CLAUDE.md) for an architecture overview and known gotchas
  before touching the processing pipeline.

## Making changes

1. Create a branch from `main`:

   ```sh
   git checkout -b my-change
   ```

2. Make your changes. Match the style of the surrounding code.
3. Verify before opening a PR:

   ```sh
   npx -p typescript tsc --noEmit   # typecheck
   npm run build                    # production build must pass
   ```

4. If you changed the geometry or file pipelines, exercise them against real
   fonts. The `src/lib` modules are deliberately DOM-free (ArrayBuffer in/out),
   so they can be driven from a Node script: bundle a scratch test with the
   repo's own esbuild and run it against a system font — see the Testing
   section of [CLAUDE.md](CLAUDE.md).

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add hole pattern presets
fix: accept .pdf drops on the landing page
docs: expand PDF limitations in README
refactor: extract sfnt assembly helper
```

Keep the subject line imperative and under ~72 characters; add a body when the
"why" isn't obvious from the diff.

## Pull requests

- Keep PRs focused on one change.
- Describe what changed and why, and note how you verified it.
- Include before/after details (e.g. measured ink savings, file sizes) when
  changing geometry parameters.

## Reporting bugs

Open an issue with:

- What you uploaded (file type; attach a sample if it's freely licensed),
- The Eco Intensity you used,
- What you expected vs. what happened (include the exact error or warning
  text shown in the UI),
- Browser and OS.

Please don't attach commercially licensed fonts or private documents to
public issues.
