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

Live Cloudflare R2 was not tested. The R2 preset only fills the endpoint template, region `auto`, and path-style addressing. Backup tests talk to a local S3 server, not to Cloudflare.

A multi-arch image build was not run. The Dockerfile uses `node:22-bookworm` and does not pin `linux/amd64`, but this repository has no log of a finished multi-arch image build. Do not treat a live R2 test or a published multi-arch image as done.
