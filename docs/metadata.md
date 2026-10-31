# Metadata agent

QiJuan uses an OpenAI-compatible tool-calling model to identify a book and fill its catalog metadata. For uploads, the agent replaces the direct Open Library lookup. Every new, non-duplicate uploaded EPUB or PDF must pass through the agent before QiJuan creates an edition or stores the managed book blob.

Folder imports on indexed libraries do not use the agent. They stay on the metadata embedded in the file. An administrator can also run the agent on an existing book from its page.

## Configuration

Sign in as an administrator, open **Settings**, and use the **Metadata agent** panel. Save:

| Field | Meaning |
| --- | --- |
| Base URL | The OpenAI-compatible API root, for example `https://api.deepseek.com/v1`. QiJuan appends `/chat/completions`. |
| Model | The model name the server expects for tool calls, for example `deepseek-chat`. |
| API key | Optional. When set, QiJuan sends it as `Authorization: Bearer <key>`. Leave it blank for a local server that does not check credentials. |
| Web search | `DeepSeek` or `Off`. Turns on the `web_search`, `fetch_page`, and `page_images` tools (see [Web search](#web-search)). It defaults to `DeepSeek` when the base URL's host is `api.deepseek.com` and to `Off` otherwise, until you choose. |
| DeepSeek search key | Shown only when web search is `DeepSeek` and the base URL is not DeepSeek. The DeepSeek API key used for Search and Fetch. Without it, the web tools are not offered. |
| Google Books API key | Optional. Sent to the Google Books API as the `key` query parameter. Without it, lookups use Google's anonymous shared quota, which is often used up. |

The base URL must be an `http` or `https` URL with no query, fragment, username, or password. Use a model that supports OpenAI-style tool calls; a chat-only model cannot submit metadata.

DeepSeek example:

```text
Base URL:  https://api.deepseek.com/v1
Model:     deepseek-chat
API key:   your DeepSeek API key
```

Local OpenAI-compatible example, such as an Ollama server with a tool-calling model:

```text
Base URL:  http://127.0.0.1:11434/v1
Model:     qwen2.5:7b
API key:   leave blank
```

These are configuration examples, not evidence that this repository called either provider in a test. The repository's agent tests stub the model transport and Open Library.

**Test connection** sends a small chat request to the saved base URL and model: one `Reply with OK.` message, no tools, and `max_tokens` 8. It reports reachability, a rejected credential, or an unexpected response. It does not run a metadata lookup and does not prove that the model handles tools. The test uses the saved values, so save first if you changed the form.

**Fetch models** sends `GET <base URL>/models` and offers the returned model ids as suggestions on the Model field. It uses the base URL and API key currently in the form, so you do not have to save first. If the key field is blank and the base URL is the saved one, QiJuan uses the saved key; a blank key for a different base URL sends no key. It reads the OpenAI `{ "data": [{ "id": ... }] }` shape or a plain array of ids, and keeps at most 500 ids. It does not change a model you already typed, and you can still type any name. Some servers do not list their models; the panel then says so, and you type the model name instead.

**Save** writes the configuration. Leaving a key field blank on a later save keeps the saved key; this applies to all three keys. **Remove** deletes the saved configuration; later new uploads fail until it is configured again.

The configuration is stored in `<data directory>/metadata-assistant.json`, with file mode `0600`. It is not stored in SQLite. The settings API is administrator-only and returns only `configured`, `baseUrl`, `model`, `apiKeyConfigured`, `apiKeyHint`, `webSearch` (the effective mode), `webSearchAvailable` (whether the web tools are offered), `searchApiKeyConfigured`, `searchApiKeyHint`, `googleBooksApiKeyConfigured`, and `googleBooksApiKeyHint`. Each hint is the last four characters of its key. No key is returned in API responses or written to logs. `PUT /api/metadata/assistant` accepts `baseUrl`, `model`, `apiKey`, `webSearch` (`deepseek` or `off`; when it is left out, a saved choice is kept and otherwise the base URL's default applies), `searchApiKey`, and `googleBooksApiKey`. For the two extra keys, a blank or absent value keeps the saved key and `null` removes it.

## What the agent receives

The model receives a system prompt and one user message. The user message is JSON with the uploaded filename, the format, and a `fields` object:

```json
{
  "filename": "quiet-book.epub",
  "format": "epub",
  "fields": {
    "title": "Quiet Book",
    "authors": ["Ada Example"],
    "translators": [],
    "description": "A book about a quiet library.",
    "publisher": "Example Press",
    "publishedDate": "2024",
    "language": "en",
    "identifiers": [{ "scheme": "isbn", "value": "9780140328721" }],
    "series": null,
    "seriesOrder": null
  }
}
```

The user message contains only these bibliographic values:

- title
- authors
- translators
- description
- publisher
- published date
- language
- identifiers (scheme and value)
- series
- series order

For an upload, the fields come from the file's embedded metadata. For a manual run, they come from the edition's catalog values. Values the source does not have are sent as `null`. The upload path does not extract a published date, series, or series order from the file, so those are normally `null` there and the agent must find them another way.

The agent never receives book text, chapter contents, extracted text, OCR, cover images, or file bytes. The server reads and hashes the uploaded file locally before the model call, but only the JSON above is sent as the user message.

## Tools and limits

QiJuan owns every tool and runs it itself, so the agent works with any OpenAI-compatible tool-calling model. The tools offered on a run are:

| Tool | What it does | Limit |
| --- | --- | --- |
| `search_open_library` | Searches Open Library by title, author, or ISBN. Returns at most five compact results. | Fixed `/search.json`; result text capped at 8,000 characters. |
| `get_open_library_record` | Reads one work record, edition record, or ISBN record. The key must be `/works/OL<digits>W`, `/books/OL<digits>M`, or an ISBN-10/ISBN-13 with an optional `urn:isbn:` or `isbn:` prefix. | Fixed work, edition, or ISBN endpoints; result text capped at 12,000 characters. URLs, other paths, and other record keys are refused without a request. |
| `google_books` | Looks up Google Books volumes by `isbn` or a free-text `query`. Returns at most five compact volumes: id, title, subtitle, authors, publisher, published date, language, industry identifiers, a description shortened to 1,000 characters, the canonical link, and `imageLinks` (the largest image Google lists, upgraded to `https` and without the `edge=curl` page-curl effect). Always offered. | `GET https://www.googleapis.com/books/v1/volumes`; at most 4 calls per run; result text capped at 8,000 characters. |
| `web_search` | Searches the web through DeepSeek Search with a `query` (1–128 characters) and an optional `count`. Returns at most 8 results, each with title, URL, host, site name, date, and a summary of up to 500 characters. Offered only when web search is available. | At most 4 calls per run; result text capped at 8,000 characters. |
| `fetch_page` | Reads one public web page as Markdown through DeepSeek Fetch. Offered only when web search is available. | At most 4 calls per run; result text capped at 12,000 characters (the content is shortened and the result marked `truncated`). The URL is checked first, see below. |
| `page_images` | Lists the likely cover images on one public page (`{ url }`). QiJuan's server fetches the page HTML itself; no DeepSeek call and no cost. Returns up to 8 absolute `http(s)` image URLs, each `{ url, kind, alt?, width?, height? }` with `kind` one of `og:image`, `twitter:image`, `image_src`, or `img`: meta tags first, then `<img>` tags whose src, alt, class, or id suggest a cover (`cover`, `封面`, `mainpic`, `lpic`, `subject`), then other images. `data:` URIs, SVG, GIF, icons, sprites, logos, avatars, and tracking pixels are skipped. Offered only when web search is available. | At most 4 calls per run; the same URL rules as `fetch_page`, re-checked on every redirect (at most 3); 30 seconds; only the first 2 MiB of HTML is read (the result is marked `pageTruncated`); result text capped at 8,000 characters. |
| `submit_metadata` | Submits the final proposal. May carry an optional `cover: { url, sourceUrl? }`. QiJuan cleans and validates it. | An invalid submission is returned to the model as a tool error naming the missing or invalid fields, so it can correct the answer. |

The model can reach Open Library only through the two search and record tools. QiJuan builds each tool request from `QIJUAN_OPEN_LIBRARY_ORIGIN` (default `https://openlibrary.org`) and a fixed path. The model cannot choose a host or path there. Set the origin before starting the server; it is read at startup.

A Google Books HTTP 429 is returned to the model, and recorded in the trajectory, as `rate_limited` with a plain explanation: the configured key's quota or the anonymous shared quota is used up, and an administrator can add a key in Settings. The model is told not to retry.

### Web search

With web search on and a key available, the agent also gets `web_search` and `fetch_page`. Both call DeepSeek's [Search and Fetch APIs](https://api-docs.deepseek.com/guides/search/):

- `POST https://api.deepseek.com/v1/tools/search` with `{ "query": ..., "count": ... }`, which returns `{ "results": [{ "title", "url", "snippet", "summary", "content", "site_name", "site_icon", "date", "rerank_score", "authority" }] }`. QiJuan does not request page content (`need_content` stays `false`).
- `POST https://api.deepseek.com/v1/tools/fetch` with `{ "url": ... }`, which returns `{ "title", "content" }` with the page as Markdown.

Both send `Authorization: Bearer <key>`, have a 30-second timeout, and do not follow redirects. The key is the agent's own API key when the base URL's host is `api.deepseek.com`. For any other model server, the agent's key is never sent to DeepSeek, and the separate **DeepSeek search key** is required. Without a usable key, the two tools are not offered and a call to them is refused. DeepSeek's documented errors reach the model as tool errors it can act on: `unauthorized` (401), `insufficient_balance` (402), `blocked` (403, Fetch security policy), `not_found` (404, no usable page content), `rate_limited` (429), and the API's own error message.

Before a URL is passed to Fetch, QiJuan accepts only `http` and `https` URLs on the default port, with no username or password and at most 8,192 characters. It refuses IP-address hosts, `localhost` and other local or single-label names, and hosts whose DNS answers include a loopback, private, link-local, carrier-grade NAT, documentation, multicast, or other reserved address. DeepSeek fetches the page, not QiJuan, but internal addresses are still never passed on.

**Douban.** Douban has no public API, and QiJuan has no Douban scraper. The agent reaches Douban only by finding a page with `web_search` (for example with `site:book.douban.com`) and reading it with `fetch_page`. Fetch returns Markdown without image URLs, so for a cover the agent calls `page_images` on the subject page, whose `og:image` is the cover.

**Cost.** DeepSeek bills Search and Fetch per successful request, not by tokens. Its documentation lists $0.75 per 1,000 successful requests for each API, and says that only HTTP 200 responses with a result are billed (failed requests, empty searches, and timeouts are not), and that per-request billing starts at 00:00 Beijing time on 1 November 2026. One run makes at most 4 searches and 4 page reads. Check DeepSeek's pricing before relying on these numbers.

The prompt tells the agent to look up an identifier from the file directly before searching by title, to use `web_search` and `fetch_page` to find an authoritative record when Open Library lacks the book (common for Chinese books), to take the official title from that record rather than the filename, and to submit every identifier it is confident about with the URL where it found it, never an invented one.

The prompt also asks for a cover of *this* edition (matching ISBN, publisher, and edition, never another printing, translation, or volume) from the publisher, a Douban subject page, Google Books `imageLinks`, or a national library catalogue; to use only an image URL a tool returned, with the page it came from as `sourceUrl`; never to invent or edit a URL; and to omit `cover` when unsure. How the server checks and uses that image is described in [Covers](#covers).

The agent loop is bounded:

- at most 6 model turns
- at most 10 tool calls in total, `submit_metadata` included
- at most 4 calls each to `web_search`, `fetch_page`, `page_images`, and `google_books`, within the 10
- 150 seconds for the whole loop, including model turns and tool calls
- 30 seconds per model, DeepSeek, or Google Books HTTP request
- 10 seconds per Open Library request
- at most 2 MiB for a model response
- at most 120,000 characters for tool arguments
- at most 12,000 characters for one tool result passed back to the model

An invalid submission, malformed tool arguments, or failed tool call still counts toward the ten-call limit. A correction must fit inside the same budget. If the model produces no valid submission before a limit is reached, the run fails with `metadata_incomplete`.

## Required metadata

A submission is accepted only when all of these survive cleaning:

- a title
- at least one author
- a language
- a description
- a publisher
- a published date

Identifiers are not required. A book the agent cannot identify is still imported, as an Unidentified edition (see [Identifiers and merging](#identifiers-and-merging)).

Cleaning trims values, collapses whitespace where appropriate, and rejects control characters and overlong values. Each identifier is validated and normalized for its scheme. One that fails, for example an ISBN with a bad check digit, is dropped, and the trajectory records a `note` step naming it and the reason. Identifiers in other schemes are kept as given. The server checks presence and basic cleanliness, not whether a date is a real calendar date or whether the model's facts are true.

A submission missing any of these values is rejected as a tool error naming the fields, so the model can correct it. If no complete submission arrives within the loop bounds, the upload item fails with `metadata_incomplete` and no edition is created.

Identifiers, translators, series, series order, and the cover are optional. Series order is used only when a series name is present. A cover is best effort: a missing or failed cover does not reject an upload.

## Uploads and rejection

An upload is handled in this order:

1. The uploaded file is staged and its hash is checked. A duplicate is linked to the existing edition and does not call the model.
2. The file is parsed locally for embedded metadata. That metadata is an input to the agent, not a fallback.
3. The metadata agent runs with the fields above.
4. A complete proposal is committed as the edition and managed file asset. Its cover is, in order: the agent's verified image, Open Library's cover for the cover id or ISBN (only if Open Library actually returns an image), and otherwise the cover embedded in the file. If the proposal's identifiers match an edition already in the library, the file may instead join that edition, or wait for an administrator's decision; see [Identifiers and merging](#identifiers-and-merging).

If no assistant is configured, each new (non-duplicate) uploaded file fails with `metadata_assistant_unconfigured` before any model request. A missing or invalid model response, a network failure, or a rejected credential produces a clear item error such as `metadata_incomplete`, `metadata_unavailable`, `assistant_unauthorized`, or `assistant_invalid_response`. A malformed or unsupported file fails earlier with its own error.

A failed upload item creates no edition, no file asset, no cover, and no managed blob. The staged upload is discarded when the upload job finishes, except for a file that needs confirmation, which is kept until it is resolved. Other files in the same upload continue. The failure is not repaired from embedded metadata or by a direct Open Library lookup: uploads have no such fallback. Re-upload the file after fixing the assistant or its answer.

## Manual runs on existing books

An administrator can open a book and choose **Run metadata agent**. This uses the same saved assistant, the same tools, and the same limits.

The result is a preview, not an immediate change. The preview shows current and proposed values, the source and model name, and a checkbox for each changed field. Proposed changes start selected; deselect any you do not want. Pressing **Apply selected** writes the checked, unlocked fields and locks them. **Discard suggestions** throws the preview away and applies nothing. Apart from the one cover exception below, nothing is applied before an administrator acts.

**Covers are applied automatically only to books without one.** When the lookup finds a verified cover (the agent's image passed the checks in [Covers](#covers), or Open Library actually returned an image), the edition has no cover, and the cover field is not locked, that image becomes the edition's cover as soon as the preview is created. The cover is not locked, so a later lookup or upload can still replace it, and a trajectory note `cover_auto_applied` records its size and host. No text field is ever changed this way: titles, authors, descriptions, identifiers, series, and the rest wait for review. In the preview the cover row then reads unchanged, and applying the preview does not write the cover again. A book that already has a cover only gets a proposal, as before.

**Lookup ready to review.** The book page tells administrators when a lookup is waiting, with a ruled line under the title block ("A metadata lookup found 4 changes · Review"). **Review** opens the editor on that preview. The edition payload carries this for administrators only, as `pendingLookup: { previewId, createdAt, changedFields } | null`: the edition's latest preview that has not been applied or discarded and still proposes at least one change. Previews do not expire. A new lookup replaces the edition's previous preview, applying marks it applied (`metadata_previews.applied_at`, migration 0019), and discarding deletes it. `GET /api/editions/:editionId/metadata/previews/:previewId` returns a pending preview rebuilt against the edition as it is now. `DELETE` on the same path discards it and releases its staged cover. Both are for administrators only.

Fields you have locked are marked kept and are never overwritten, even if they appear in the proposal. A manual run also requires a configured assistant; without one the lookup job fails with `metadata_assistant_unconfigured`, with no direct Open Library fallback.

The cover is downloaded while the preview is built, not when it is applied. The cover row shows the current and the found cover side by side, with the host it came from (linked to the source page) and its pixel size, or **No cover found** when no image was obtained. Applying writes exactly the image shown; nothing is downloaded at apply time. A failed or missing cover never fails the lookup or the apply.

## Identifiers and merging

An edition carries any number of identifiers. Each is stored in a normalized form, with a canonical link where the scheme has one:

| Scheme | Stored as | Link |
| --- | --- | --- |
| `isbn` | ISBN-13 digits. An ISBN-10 is converted. Both check digits are verified; hyphens, spaces, and `urn:isbn:` are removed. | none |
| `issn` | `NNNN-NNNC`, check character verified | `https://portal.issn.org/resource/ISSN/<v>` |
| `doi` | lowercase `10.…/…`, without `https://doi.org/`, `doi:`, or `urn:doi:` | `https://doi.org/<v>` |
| `oclc` | digits without leading zeros; `(OCoLC)`, `ocm`, `ocn`, `on` removed | `https://www.worldcat.org/oclc/<v>` |
| `lccn` | the Library of Congress normalized form | `https://lccn.loc.gov/<v>` |
| `olid` | an Open Library edition (`OL…M`) or work (`OL…W`) key | `https://openlibrary.org/books/<v>` or `/works/<v>` |
| `google_books` | the volume id, case kept | `https://books.google.com/books?id=<v>` |
| `douban` | the subject id | `https://book.douban.com/subject/<v>/` |

Common aliases are accepted (`isbn13`, `isbn-10`, `eissn`, `openlibrary`, `googlebooks`, …), and URL forms of DOI, Open Library, Google Books, and Douban ids are reduced to the id. Other schemes, such as the `uuid` an EPUB often carries, are kept as given, have no link, and never merge anything. The same rules apply everywhere identifiers enter: the agent's submission, EPUB and PDF metadata, manual edits, rescans, and the OPDS feed (which writes `urn:isbn:`, `urn:issn:`, and `urn:doi:` identifiers, and the canonical link for the others).

Each identifier also records where it came from: `embedded` (the file said so), `agent` (the metadata agent found it), or `manual` (someone typed it), an optional source URL (the page where the agent found it), and when it was added. An agent identifier that the file also carried is recorded as `embedded`. Edition payloads give everyone `scheme`, `value`, and `url`; administrators also get `source`, `sourceUrl`, and `createdAt`.

An edition with no identifier in one of the schemes above is **Unidentified**. Imports never fail for lacking one. `GET /api/library?identified=0` lists Unidentified editions and `identified=1` the others; each card carries `identified`.

### Merging new files

When a new upload or folder import carries a strong identifier (`isbn`, `issn`, `doi`, `oclc`, or `lccn`) that a live edition in the same library already has, the file joins that edition as another file instead of creating a new one. A platform id (`olid`, `google_books`, `douban`) merges the same way, on the same scheme and value. The edition's fields are left as they are; identifiers it lacks are added, unless its identifiers are locked. The job item says `merged: true`. Libraries never merge into each other.

A match is not merged silently when:

- the titles differ, ignoring case, full- and half-width forms, punctuation, and spacing (an alternate title counts);
- both have authors and they share none;
- the edition already has a file in this format (a second PDF with different bytes, say; identical bytes are a duplicate, as before); or
- the identifiers point at more than one edition.

Then the item waits in `needs_confirmation`, with `candidateEditionId` and `conflicts` (`title`, `authors`, `format`, `ambiguous`). Admins also get `incoming`: the file's own title, authors and format, and the identifier that matched (`{ scheme, value }`, a strong scheme before a platform id), for a side-by-side comparison. Nothing is written for it yet: no edition, no file asset, no blob. The upload's staged file and the agent's proposal are kept. When the job has finished, an administrator chooses:

- `POST /api/jobs/:jobId/items/:itemId/merge`: add the file to the candidate edition;
- `POST /api/jobs/:jobId/items/:itemId/keep-separate`: create a separate edition, which then shows the candidate under similar editions.

Either answers `202` with the job, which is queued again; the worker finishes the file without calling the model a second time. They answer `403` to readers, `409` (`conflict`) while the job is still queued or running or when the item is not waiting, and `404` when merging into a candidate that has since been removed. The import page shows both records side by side, marks the fields that differ, and offers both choices; readers see only that the file is waiting.

### Existing editions

Identifiers never merge editions that already exist, by migration or otherwise. Editions in one library that share a mergeable identifier are listed under the book page's similar editions instead, with the reason `identifier` (beside `title_author`, the same title and main author). With `identifier`, the suggestion also names the first identifier the two share (`identifier: { scheme, value }`). Migration 0016 records these pairs for the existing catalog, and a manual edit, an applied agent preview, or a rescan that gives an edition such an identifier records new ones.

### Editing and locks

`PATCH /api/editions/:id` with `identifiers` replaces the whole list, so it adds, removes, and changes entries at once. Each entry is `{ scheme, value, sourceUrl? }`; the read-only fields of the edition payload may be sent back and are ignored. A value that does not validate fails the edit with `400 invalid_identifier` and the `index` of the rejected entry in the request, so the editor can mark that row, except an entry the edition already stores unchanged (an old value kept by migration 0016). Entries already present keep their provenance; new ones are `manual`. The edit locks the identifiers, as with other fields: a locked list is not changed by rescans, agent previews, or merges. A rescan of an unlocked edition replaces only its `embedded` identifiers.

Migration 0016 moves the old identifiers into `edition_identifiers`. It lowercases scheme names and maps aliases, converts valid ISBN-10s and spelled ISBN-13s to ISBN-13, and strips DOI prefixes. A value that does not validate is kept as it was. Two spellings of one identifier on the same edition become one row. The source of old rows is inferred: `manual` if the edition's identifiers were locked, `agent` for editions created by an upload, `embedded` otherwise.

## Folder and indexed imports

Folder imports apply to indexed libraries. They read the metadata embedded in each file and commit that metadata, with the identifier merging above. They never call the metadata agent, per file or otherwise, even when an assistant is configured. Rescan and metadata refresh also re-read embedded metadata and do not call the model.

An administrator can still run the agent on an individual imported book with the preview and confirmation flow above. That is a manual action; it does not change how later folder imports behave.

## Covers

**Where a cover comes from.** When the agent submits `cover.url`, the server downloads that image. If the agent gave none, or the image fails a check, the server asks Open Library's cover service for the proposal's cover id, then its ISBN, and uses the answer only if it is an image (an ISBN alone is never reported as a cover). For uploads, the cover embedded in the file is the last resort. Custom covers can also be set from the book page, outside this flow.

**How an agent image is checked.** The download uses the same URL rules as `fetch_page` and `page_images` (`http`/`https` only, no credentials, no IP-address or local hosts, no host resolving to a private or reserved address, default ports), follows at most 3 redirects with each hop re-checked, and has a 30-second timeout. The image is accepted only if:

- its magic bytes say JPEG, PNG, or WebP (the `Content-Type` header is not trusted; an HTML or other non-image response is refused);
- it is between 2 KiB and 5 MiB;
- its pixel size, read from the JPEG frame header, PNG `IHDR`, or WebP `VP8`/`VP8L`/`VP8X` header, is at least 150 px wide;
- its height divided by its width is between 1.0 and 2.0, a book-cover shape.

Otherwise it is rejected with a reason (`too_small`, `too_narrow`, `wrong_aspect`, `unsupported_type`, `http_error`, …). The request sends a browser-like User-Agent and no Referer, except that the source page's origin is sent as Referer when the image host belongs to the same site (for example `img3.doubanio.com` for a `book.douban.com` page), since such hosts refuse foreign or missing referrers. Every outcome is a trajectory note, such as "Cover verified 357×500 JPEG from img3.doubanio.com" or the rejection reason.

**Staging and applying.** For a manual run, the obtained image is stored as an immutable, content-addressed blob like any cover and referenced from the preview. An administrator-only endpoint, `GET /api/editions/:editionId/metadata/previews/:previewId/cover`, serves it to the preview. A book without a cover takes the staged image at once (see [Manual runs on existing books](#manual-runs-on-existing-books)). Otherwise only the cover the administrator confirmed is applied. A locked cover is never downloaded or replaced. The staged blob is released when the preview is applied, discarded, or replaced by a new lookup, unless it became the edition's cover or something else references the same bytes. When the server starts, it gives every coverless, unlocked edition the verified cover still staged in its pending preview. This covers previews made before covers were applied automatically, and repeating it changes nothing. Backups do not include staged preview images; after a restore, an old preview simply has no cover to apply.

If no cover is found at all, the edition keeps its current cover, or none.

The web interface then draws a generated cover fallback: a typographic cover made from the title and author, with a color derived from the title. This fallback is drawn by the client; it is not an image file in the catalog. The OPDS feed links a cover only when an image is actually stored.

## Trajectory

Each agent run is recorded as a trajectory: the ordered steps the agent took. An upload keeps one trajectory per file, and a manual run on an existing book keeps one with its lookup job and the preview it produced. Steps are written as they happen, so the import page and the book page show a run while it is still working.

A trajectory records these steps, each with a sequence number and a time:

- **input**: the filename, format, and whitelisted bibliographic fields sent to the model (the same object as the request's user message), the model name, the run limits, and the names of the tools offered. The fixed system prompt is named, not copied.
- **model**: any text the model wrote, the tools it asked for, the turn number, and how long the request took.
- **tool_call** and **tool_result**: the tool name and its arguments, then a short summary (a result or volume count with the first title, a record key and title, a fetched page's title, host, and URL, or an error code with its explanation), the result itself shortened to 12,000 characters, and how long the call took. The trajectory view labels the web tools "Searched the web", "Read page", "Found images on page" (with the image count), and "Looked up Google Books", links the host of a read or scanned page, lists the image URLs `page_images` found, and lists each search result's title and host above its raw JSON.
- **submit**: the accepted proposal, or why a submission was rejected.
- **note**: something the import did with the run's data. A cover note (shown as "Cover check") records whether the agent's image was verified or rejected, whether Open Library or the file supplied the cover, and `cover_auto_applied` when a lookup's cover went straight to a coverless book. `identifiers_dropped` lists identifiers removed as invalid, from the file (`origin: embedded`, recorded before the model runs) or from the submission, each with its scheme, value, and reason (`invalid_scheme`, `invalid_value`, `invalid_format`, `invalid_checksum`).
- **end**: accepted, failed, timeout, or limit, with the error code, the number of turns and tool calls, and the total time.

A run that fails at the model or Open Library still ends with an `end` step. When the agent is not configured, no run happens and no trajectory is written; the import page says so and links to Settings.

One trajectory is kept to 256 KiB. Near that size, later steps keep only their short fields and are marked as shortened. The `end` step is always kept.

Only administrators can see trajectories. The job payloads carry a trajectory id and step count only for administrators, and `GET /api/metadata/trajectories/:id` answers `403` to readers and `404` once a trajectory is gone. Trajectories are deleted 30 days after the run started. Pruning runs when the job worker starts and whenever a new run is recorded.

A trajectory never holds book text, OCR, or file bytes, since the agent never receives them. It never holds an API key, the Google Books request URL (which carries the key), or request headers either.

## Ratings

The book page shows each edition's rating on other sites, in one line under the title and author: Douban (out of 10), Goodreads, Open Library, and Google Books (each out of 5). Every source keeps its own scale, and scores are never converted or averaged. A source that has a page for the book but no score (Douban shows none below about ten votes, and Goodreads often has none for Chinese editions) appears as a plain link. A source with nothing for the book is left out. When the identifiers do not already link to WorldCat, a WorldCat link by ISBN follows the sources.

Ratings are not part of the metadata agent and never involve the model. The server reads them itself, from public pages and APIs, by an existing provider id first (a Douban subject id, an Open Library OLID, or a Google Books volume id) and then by ISBN:

- **Douban:** `book.douban.com/isbn/<isbn>/`, which redirects to the subject page, whose rating block is read.
- **Goodreads:** `www.goodreads.com/book/isbn/<isbn>`, which redirects to the book page, whose schema.org JSON-LD carries the rating. If the ISBN-13 is not found, the ISBN-10 is tried.
- **Open Library:** the work's `/works/<id>/ratings.json`, with the work found through the edition record.
- **Google Books:** the volumes API, with the Google Books key from the assistant settings when one is saved. The key never appears in a stored URL. Without a key the shared anonymous quota is often exhausted, and Google Books then shows nothing.

Douban and Goodreads have no API for this, so QiJuan reads their HTML. A site redesign can stop a source from working. The fetch then records an error, the page leaves that source out, and the rest of the line still works. Ratings are stored in `edition_ratings`, one row per edition and source.

Fetching runs in a background ratings worker, separate from the import and metadata jobs, and a page never waits for it. An edition is queued when it gains, loses, or changes an ISBN or a provider id (through an import, an applied lookup, a rescan, or a manual edit), and when its page is viewed while a source has no rating yet, its rating is older than 30 days, or its last fetch failed more than a day ago. An administrator can also choose **Refresh ratings** on the book page. Existing books are not fetched all at once when this feature is installed; they are fetched as their pages are opened.

The worker fetches one edition at a time. Requests to the same host, redirects included, are at least 1.5 seconds apart. When a source answers 403, 418, or 429, or Douban sends the request to its anti-bot page, that source is skipped for 6 hours and the edition is retried after that; a score already stored is kept. Every request goes through the same checks as cover downloads: public http(s) hosts only, each redirect re-checked, a timeout, and a size limit.

Every signed-in user sees the ratings on the book page. Readers see only scores and links. Administrators also see when the ratings were last updated and the refresh control, and the API gives them each source's status and failure reason. Ratings do not appear in the library grid or list.

Each source on the book page shows that site's own icon. QiJuan bundles no logos. The server reads each site's homepage (Douban, Goodreads, Open Library, Google Books and WorldCat), follows the PNG, ICO, WebP or JPEG icon it declares, or `/favicon.ico`, and keeps the file in `provider-icons/` in the data directory for 30 days. After a failed lookup it waits six hours before asking that site again, and the page shows the source's name without an icon.

The ratings tests use stubbed pages and APIs. The sites see the server's IP address, a browser-like User-Agent, and the ISBN or provider id being looked up.

## Private books

A book can be kept private from the metadata agent. Check **Keep private from the metadata agent** on the import screen to cover every file in that batch (`POST /api/imports?libraryId=…&private=1`, or `"private": true` in the folder-import body). For an existing book, an administrator can use the same checkbox in the book page's Details tab (`PATCH /api/editions/:editionId` with `{ "metadataPrivate": true | false }`; anyone else gets 403). The edition payload carries `metadataPrivate`, and the book header shows a small **Private** mark. The flag is `editions.metadata_private`, and `job_items.metadata_private` holds the batch's choice until the file has an edition (migration 0021).

**Nothing about a private book is sent to the metadata assistant or its provider.** That covers the filename, the embedded fields and identifiers, extracted text, page images and covers. No model request is made for the book, and no `web_search`, `fetch_page`, `page_images`, Google Books or Open Library tool call is made on its behalf. A private upload also skips the Open Library cover fallback.

- **Uploads:** the edition is built from the file's own metadata (the EPUB OPF or the PDF info and XMP). If the file has no title, the filename without its extension is used. Its embedded cover is used if it has one. No other field is required, so a private upload never fails with `metadata_incomplete`, and it works with no assistant configured. Identifier merging and duplicate detection work as usual and stay local. When a private file joins or duplicates an existing edition, that edition becomes private. A file that is not private never makes a private edition public.
- **Lookups:** **Run metadata agent** is disabled on a private book, with a note saying why. `POST …/metadata/lookup` and `POST …/metadata/apply` return 409 `metadata_private`. A lookup job that reaches the worker anyway fails with `metadata_private` before any request is made. As a final guard, the agent itself refuses to start for a private book.
- **Making a book private** discards its pending lookup preview and that preview's staged cover, so an older agent result cannot be applied later. A lookup still running when the book is made private is dropped, not staged. Its cover is never applied automatically.

Some things still happen for a private book. Ratings are fetched as usual (see [Ratings](#ratings)): they are not part of the agent and never involve a model, but Douban, Goodreads, Open Library and Google Books still see the book's ISBN or provider id. Local work also continues as usual, including the cover tint, search indexing, metadata refresh from the file and similar-edition suggestions. Making a book public again does not run a lookup; it only allows you to start one.

## Privacy and operations

The model endpoint is supplied by an administrator and can be remote or local. The metadata in the request leaves the QiJuan server and goes to that endpoint. Do not point it at a provider you do not trust with titles, authors, descriptions, and identifiers. Book text, OCR, and file bytes are not part of that request.

The tools send the model's queries to other services. Google Books receives ISBNs and search queries. With web search on, DeepSeek receives search queries and the URLs to read. The model writes these queries from what it was given, so they contain titles, authors, filenames, ISBNs, or other identifiers. Book text is never sent to any of them. Turn web search off if you do not want queries sent to DeepSeek; Google Books is always offered.

Covers involve direct connections from the QiJuan server to the internet. `page_images` fetches the chosen page itself, and the server downloads the chosen cover image itself (also when the image came from Google Books, with web search off). Those sites see the server's IP address and a browser-like User-Agent, and may see a Referer naming the source site's origin. No cookie, key, or book data is sent. In the lookup flow, a verified image is applied without confirmation only to a book that has no cover and an unlocked cover field. Every other image waits for an administrator to confirm it in the preview. Uploads apply a verified cover directly, like the rest of their metadata.

The assistant API key is optional for local servers. When present, it is stored server-side in the mode-`0600` JSON file, sent only in the model request's `Authorization` header (and, for a DeepSeek base URL with web search on, in the Search and Fetch requests), and returned to the settings screen only as a masked hint. The DeepSeek search key and the Google Books key are stored and masked the same way, and each is sent only to its own service. The settings routes and manual metadata runs are administrator-only.

Model behavior varies. The agent needs a model that emits tool calls, and a complete proposal can still contain a wrong but plausible field. Uploads commit a validated proposal without a preview, so check newly imported books. For manual runs, the preview and the per-field confirmation are the safety net, and locked fields stay as you set them.

The repository's agent tests use stubbed model, Open Library, DeepSeek Search and Fetch, Google Books, and DNS transports. Page and image downloads are stubbed too. They do not call DeepSeek, Google, Douban, OpenAI, Ollama, or another live service, and this document is not a report of a live provider test. A successful **Test connection** only shows that the saved endpoint answered; it does not prove metadata quality or tool support.

See [limitations.md](limitations.md) for what QiJuan does not do, and [development.md](development.md) for where the settings file lives.
