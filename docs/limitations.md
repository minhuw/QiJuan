# Limitations

QiJuan in this repository is a self-hosted personal library for EPUB and PDF: a catalog, import, the readers, shelves and reading state, restic backup, annotation export, and an OPDS 1.2 catalog.

These later milestones are not implemented:

- watched folders
- smart shelves
- full-text search of book contents
- OCR
- PDF highlights
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
- AI features

Live Cloudflare R2 was not tested. The R2 preset only fills the endpoint template, region `auto`, and path-style addressing. Backup tests talk to a local S3 server (MinIO), not to Cloudflare. Do not treat the R2 preset as a tested provider.

The publish workflow builds and can push one `linux/amd64` image to GHCR. The Dockerfile uses `node:22-bookworm` and installs the pinned restic build for amd64 after checking its SHA-256. A build for another architecture stops there. No multi-arch image is published, and this checkout has no log of a finished push to GHCR. Do not treat a live R2 test or a published multi-arch image as done.
