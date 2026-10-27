# OPDS

QiJuan serves an OPDS Catalog 1.2 Atom feed. The feed is shaped for a typical OPDS 1.2 reader such as KOReader. This document describes that shape. It is not a report of a live device test.

Reading-progress synchronization is not implemented. The catalog has no progress links, and QiJuan does not offer a reading-progress sync endpoint.

## Version

OPDS Catalog 1.2.

Feeds use `application/atom+xml;profile=opds-catalog;kind=navigation` or `kind=acquisition`.

## Authentication

HTTP Basic. The username is the QiJuan account name. The password is a per-client token, not the account password.

Create a token while signed in to the web app:

```http
POST /api/opds-tokens
Content-Type: application/json

{"label":"KOReader"}
```

The response includes `secret` once. QiJuan stores only the SHA-256 hash of that secret. List tokens with `GET /api/opds-tokens`. The list does not include the secret or the hash.

Revoke a token:

```http
DELETE /api/opds-tokens/:id
```

The next catalog, search, cover, or acquisition request that uses the revoked secret fails with 401. Another client's token keeps working. The account password is not accepted as the Basic password.

The token does not authorize the JSON API. `/api` routes still require the session cookie.

## Navigation

`GET /opds/catalog`

Navigation feed. One entry per library the account can read, each with a `subsection` link to that library's acquisition feed. A reader sees granted libraries only. An administrator can read every library, matching the web catalog.

The feed has two search relations, both under the same Basic credential:

- `rel="search"` with type `application/opensearchdescription+xml`, pointing at `GET /opds/search.xml`
- `rel="search"` with type `application/atom+xml;profile=opds-catalog;kind=acquisition` and an `{searchTerms}` template

## Acquisition

`GET /opds/libraries/:libraryId`

Acquisition feed of editions in that library. Each present EPUB has an acquisition link of type `application/epub+zip`. Each present PDF has type `application/pdf`. The relation is `http://opds-spec.org/acquisition/open-access`. A cover, when one is stored, is linked with `http://opds-spec.org/image` and `http://opds-spec.org/image/thumbnail`.

`GET /opds/editions/:editionId/assets/:assetId` downloads that file.

`GET /opds/editions/:editionId/cover` returns the cover image.

A library, book, download, or cover the account cannot read is denied with 403 or 404. The response does not include the title, file bytes, or cover bytes.

## Search

`GET /opds/search.xml` is the OpenSearch description. Its template is `GET /opds/search?q={searchTerms}`, an acquisition feed. Search uses the same HTTP Basic credential and the same library access as the rest of the catalog. Hits from a library the account cannot read are omitted.

## Not implemented

Reading-progress synchronization is not implemented. Do not look for a progress or sync link in the feed, or for a progress endpoint under `/opds` or `/api`.
