# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A household library: the owner (administrator) plus a few family members or friends, reached on a home server. The admin imports books, curates metadata, manages reader accounts and library grants, and keeps backups running. Readers browse the libraries they were granted, read, and keep their own place, shelves, highlights and notes.

Typical sessions: picking a book back up in the evening, browsing for the next read, reading a long stretch on a laptop, tablet or phone, and occasionally (admin only) importing a batch or checking a backup.

## Product Purpose

QiJuan (栖卷) gives a private EPUB/PDF collection a home and makes reading it pleasant. Success: books are easy to find and resume, reading is undisturbed, and the collection stays intact for years.

## Positioning

Both a calm place to read and a trustworthy archive. Unlike Calibre-Web, Kavita or Komga, it pairs a reading-first experience (EPUB/PDF readers with highlights, notes and exports) with stewardship features: an AI metadata agent with field-level previews and locks, plus restic backups with restore tests. It is built for one household, not a server farm.

## Operating Context

- Self-hosted on a home server (Node 22, SQLite catalog, Docker Compose available).
- Used on desktop, tablet and phone browsers. Reader routes are full-screen and hide the app chrome.
- Libraries mix Chinese and Latin-script books and are truly bilingual. The UI ships in English and Simplified Chinese, detected from the browser, with English as the fallback.
- OPDS 1.2 serves external reading apps. It does not sync reading progress.

## Capabilities and Constraints

- Accounts: the first visit creates the administrator and the first managed library. The admin creates reader accounts and grants libraries. Reading status, favourites, queue, ratings, shelves, positions and annotations are per-user.
- Catalog: continue reading, recently added, shelves, search and filter, grid and list views, pagination, and bulk metadata editing.
- Import: file upload to managed libraries (new non-duplicate uploads need a configured metadata agent) and indexed-folder import using embedded metadata. Import jobs have a history.
- Metadata agent: an OpenAI-compatible tool-calling agent that uses Open Library. The admin previews field changes and applies them selectively. Locked fields are kept.
- EPUB reader: table of contents, search, paginated and continuous modes, typography controls, Paper/Ink themes, bookmarks, highlights and notes.
- PDF reader: search, outline and thumbnails, zoom, continuous reading, bookmarks and annotations.
- Export: Markdown/JSON of the user's highlights and notes.
- Backup: restic to S3-compatible storage, with schedules, retention, integrity checks, restore tests and a confirmed restore.
- Open: OPDS client tokens exist on the server with no client UI yet. `docs/limitations.md` says PDF highlights are not implemented, which conflicts with the current PDF code.

## Brand Commitments

- Name: 栖卷 / QiJuan.
- Tagline: 书有归处，人有闲读。
- Copy voice: plain, quiet and brief (e.g. "Readers can browse, read, and keep their own place." / "Nothing here yet.").

## Evidence on Hand

- Synthetic demo books and covers appear in `docs/screenshots/` (library, book, reader and backup at 1280/768/390).
- There is no logo file. The 栖卷 seal is CSS-styled text.
- There are no users, testimonials or usage numbers, and none should be invented.

## Product Principles

1. Reading comes first: every screen should shorten the path back into a book, and the reader stays undisturbed.
2. Stewardship is visible but quiet: metadata, backup and import state are clear and trustworthy without dominating readers' screens.
3. CJK and Latin are equal citizens in titles, authors, covers and UI.
4. Built for one household: personal, not enterprise; no metrics theatre.
5. Admin power never leaks into a reader's view.

## Accessibility & Inclusion

Keep the existing baseline: skip link, semantic landmarks, labelled controls, live status regions, visible focus, reduced-motion support, OS dark mode, and responsive layouts down to 390px.
