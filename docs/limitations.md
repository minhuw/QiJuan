# Limitations

QiJuan in this repository is a self-hosted personal library for EPUB and PDF: a catalog, import, the readers, shelves and reading state, restic backup, annotation export, and an OPDS 1.2 catalog.

These later milestones are not implemented:

- watched folders
- smart shelves
- full-text search of book contents
- formats other than EPUB and PDF
- Calibre import
- KOReader progress sync or a KOReader-specific integration (the OPDS feed is only the catalog in [opds.md](opds.md))
- email delivery
- offline mode
- OIDC
- statistics
- a dictionary
- text to speech
- partial restore of a backup
- audiobooks
- social features
- AI features beyond the [metadata agent](metadata.md): chat, summaries, embeddings

PDF highlights and notes work in two ways. On a PDF with a text layer, select text and choose Highlight or Note. A scanned PDF has no text layer, so its text cannot be selected, searched or copied; use **Highlight area** on the reader toolbar and drag a box over the passage instead. An area highlight stores only the rectangle on the page, in PDF coordinates, with no quote.

Scanned PDFs get a text layer automatically. The server checks each PDF once, new uploads and books already in the library alike, by sampling up to eight pages with Poppler's `pdftotext`. A PDF whose sampled pages are mostly without text is queued for OCR; one with a text layer is remembered as not needing it and never processed. The result is saved, so a book is recognized only once, also across restarts. An administrator can also start it with **Recognize text (OCR)** in the book's Files tab, or from the reader's scan notice. **Remove OCR** turns it off for that file for good, until an administrator asks again. Set `QIJUAN_OCR_AUTO=0` to recognize only on request. QiJuan runs [OCRmyPDF](https://ocrmypdf.readthedocs.io/) on the server, in the background, one file at a time, with simplified Chinese and English (`chi_sim+eng`). Nothing is sent to another service. Pages that already have text are skipped, and page images, sizes and orientation are kept, so existing highlights stay in place. The result is a separate copy; the uploaded file is never changed. The reader opens the copy, so in-book search and text selection work on it, while downloads, OPDS and `?original=1` serve the original. Recognition takes roughly 2–5 seconds per page per CPU core, uses half the cores, and pauses while a backup runs. Accuracy depends on the scan: old or blurred pages, vertical text and unusual layouts give wrong characters, so copied text may need correcting. Removing the OCR goes back to the original. Backups leave the copy out because it can be made again; after a restore the reader falls back to the original until the text is recognized again. The OCR tool must be installed together with Poppler (`brew install ocrmypdf tesseract-lang poppler` on macOS; the Docker image includes both). Set `QIJUAN_OCRMYPDF` if it is not on `PATH`. Searching the whole library by book contents is still not implemented.

Identifier merging does not merge editions that already exist; it only joins new files to them (see [metadata.md](metadata.md#identifiers-and-merging)). There is no action yet to merge two existing editions, and similar editions are only listed. Identifiers are normalized and checksum-validated, not looked up: a well-formed ISBN that belongs to another book is accepted. Identifiers in schemes other than the eight listed there are kept but never link or merge, and a book with only such identifiers counts as Unidentified.

Live Cloudflare R2 was not tested. The R2 preset only fills the endpoint template, region `auto`, and path-style addressing. Backup tests talk to a local S3 server (MinIO), not to Cloudflare. Do not treat the R2 preset as a tested provider.

The publish workflow pushes one `linux/amd64` image to `ghcr.io/minhuw/qijuan`. The Dockerfile uses `node:22-bookworm` and installs the pinned restic build for amd64 after checking its SHA-256. A build for another architecture stops there. No multi-arch image is published. Do not treat a live R2 test or a published multi-arch image as done.
