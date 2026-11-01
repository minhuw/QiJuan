# Changelog

## 0.1.0 — 2026-11-01

The first tagged release of 栖卷 QiJuan, a self-hosted household library for EPUB and PDF.

### Library and reading
- Managed uploads and indexed folders, batch import with per-file results, duplicates detected by content.
- A web reader for EPUB and PDF: continuous or paged reading, saved positions per person, bookmarks, highlights and notes, annotation export.
- PDF reader: zoom on the toolbar with Ctrl/⌘ + scroll, pinch and keyboard shortcuts, fit width and fit page, and **Highlight area** for scanned pages.
- **OCR for scanned PDFs**: scans are detected and recognized automatically on the server with OCRmyPDF (simplified Chinese and English); the original file is never changed. Copying from a PDF gives clean plain text.
- Personal reading status, rating, favourites, queue and shelves; per-book reading progress.

### Catalogue
- A metadata agent (any OpenAI-compatible endpoint) with Open Library, Google Books and optional web search; every run is recorded as a trajectory for administrators. Books can be kept private from it.
- Multi-scheme identifiers (ISBN, DOI, Douban and more) with links out; new files join an existing book by identifier, conflicts wait for an administrator.
- Verified covers from the web, external ratings with site icons, file names built from metadata.
- Chinese and Latin titles sort together by pinyin in one A–Z.
- Trash with restore and permanent delete.

### Interface
- Two tabs: **Reading** (the book read last with Continue and progress, other books in progress, Want to read) and **Library** (search, filters, grid and list).
- A book menu by right-click, ⋯, long-press or the keyboard on both tabs; select several books for bulk status, shelf, favourite and Trash.
- English and simplified Chinese, light and dark.

### Administration
- Household accounts with administrators and readers, per-library access, OPDS 1.2 with tokens.
- Encrypted restic backups to S3-compatible storage with a confirmed restore.
- Editing a book's details, replacing its cover and rescanning its file are now administrator tasks; readers keep their own reading state.

### Upgrading
- 25 database migrations run automatically on start; a `.pre-migration` copy of the database is written first.
- The Docker image (`ghcr.io/minhuw/qijuan`, linux/amd64) now includes OCRmyPDF, Tesseract with simplified Chinese and English, and Poppler. Set `QIJUAN_OCR_AUTO=0` to recognize scans only on request.

### Known limitations
- The book page and the reader chrome still use the earlier visual style.
- The backup acceptance test runs only on Linux and was not run for this release.
- See [docs/limitations.md](docs/limitations.md).
