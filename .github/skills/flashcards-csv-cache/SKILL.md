---
name: flashcards-csv-cache
description: "Workflow skill for Flashcards CSV import and cache versioning. Use when users ask to add, edit, validate, normalize, or troubleshoot SourceCsvs/*.csv files, card import behavior, or service worker caching after UI/data asset changes. Includes reminders to bump cache version via build script or manual sw-version.js update when cachable assets change. Do not use for Supabase schema design, general JavaScript refactors unrelated to CSV/import/caching, or CI workflow setup."
---

# Flashcards CSV + Cache Versioning

## Purpose

Provide a reliable workflow for handling Flashcards vocabulary CSV updates while preventing stale client caches.

## Use When

- Editing files under `SourceCsvs/`.
- Diagnosing CSV import issues (bad delimiters, malformed rows, missing columns, duplicate cards).
- Converting or cleaning bilingual word lists for import.
- Updating cachable assets tied to app behavior (`app.js`, `styles.css`, `index.html`, `manifest.json`, `sw.js`, `sw-version.js`, and project text/data assets).

## Do Not Use

- Supabase table/schema migration design unrelated to CSV ingest.
- Frontend redesign tasks not touching card data/import/caching behavior.
- Build pipeline, deployment, or GitHub Actions setup.

## Workflow

1. Confirm target dataset and format expectations.
2. Validate CSV structure:
   - Ensure consistent delimiter and quote handling.
   - Ensure each row has required columns.
   - Detect empty key fields and obvious malformed lines.
3. Normalize data safely:
   - Trim accidental whitespace.
   - Preserve language-specific punctuation and diacritics when present.
   - Remove exact duplicate entries only when clearly safe.
4. Apply minimal edits to requested files.
5. If cachable assets changed, update cache version:
   - Preferred: run build script that regenerates `sw-version.js`.
   - Fallback: manually bump `CACHE_VERSION` in `sw-version.js`.
6. Verify for regressions and summarize exactly what changed.

## Tool Guidance

- Prefer fast file discovery/search before full reads.
- Use targeted edits with minimal unrelated formatting changes.
- Validate errors after edits when possible.

## Output Expectations

- Report changed files and key data/caching impacts.
- Explicitly state whether cache version was bumped and how.
- If cache bump was skipped, explain why and what remains to be done.
