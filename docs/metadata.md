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

**Save** writes the configuration. Leaving the key blank on a later save keeps the saved key. **Remove** deletes the saved configuration; later new uploads fail until it is configured again.

The configuration is stored in `<data directory>/metadata-assistant.json`, with file mode `0600`. It is not stored in SQLite. The settings API is administrator-only and returns only `configured`, `baseUrl`, `model`, `apiKeyConfigured`, and `apiKeyHint`; the hint is the last four characters of the key. The full key is not returned in API responses or written to logs.

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

The model has exactly three tools:

| Tool | What it does | Limit |
| --- | --- | --- |
| `search_open_library` | Searches Open Library by title, author, or ISBN. Returns at most five compact results. | Fixed `/search.json`; result text capped at 8,000 characters. |
| `get_open_library_record` | Reads one work record, edition record, or ISBN record. The key must be `/works/OL<digits>W`, `/books/OL<digits>M`, or an ISBN-10/ISBN-13 with an optional `urn:isbn:` or `isbn:` prefix. | Fixed work, edition, or ISBN endpoints; result text capped at 12,000 characters. URLs, other paths, and other record keys are refused without a request. |
| `submit_metadata` | Submits the final proposal. QiJuan cleans and validates it. | An invalid submission is returned to the model as a tool error naming the missing or invalid fields, so it can correct the answer. |

The model can reach Open Library only through the two search and record tools. QiJuan builds each tool request from `QIJUAN_OPEN_LIBRARY_ORIGIN` (default `https://openlibrary.org`) and a fixed path. The model cannot choose a host, path, or arbitrary URL, and there is no general web search. Set the origin before starting the server; it is read at startup.

Cover images are not a tool. After a successful submission, the server may fetch a cover from Open Library's cover service using the submitted cover id or ISBN.

The agent loop is bounded:

- at most 4 model turns
- at most 6 tool calls in total
- 90 seconds for the whole loop, including model turns and tool calls
- 30 seconds per model HTTP request
- 10 seconds per Open Library request
- at most 2 MiB for a model response
- at most 120,000 characters for tool arguments
- at most 12,000 characters for one tool result passed back to the model

An invalid submission, malformed tool arguments, or failed tool call still counts toward the six-call limit. A correction must fit inside the same budget. If the model produces no valid submission before a limit is reached, the run fails with `metadata_incomplete`.

## Required metadata

A submission is accepted only when all of these survive cleaning:

- a title
- at least one author
- a language
- a description
- a publisher
- a published date
- at least one identifier; ISBN is preferred

Cleaning trims values, collapses whitespace where appropriate, rejects control characters and overlong values, and normalizes ISBN-shaped values. An `isbn` identifier that does not normalize to an ISBN-10 or ISBN-13 value is dropped. Other identifier schemes are kept. The server checks presence and basic cleanliness, not whether a date is a real calendar date or whether the model's facts are true.

A submission missing any of these values is rejected as a tool error naming the fields, so the model can correct it. If no complete submission arrives within the loop bounds, the upload item fails with `metadata_incomplete` and no edition is created.

Translators, series, series order, and the cover are optional. Series order is used only when a series name is present. A cover is best effort: a missing or failed cover does not reject an upload.

## Uploads and rejection

An upload is handled in this order:

1. The uploaded file is staged and its hash is checked. A duplicate is linked to the existing edition and does not call the model.
2. The file is parsed locally for embedded metadata. That metadata is an input to the agent, not a fallback.
3. The metadata agent runs with the fields above.
4. A complete proposal is committed as the edition and managed file asset. A cover is fetched if the proposal has a cover id or ISBN.

If no assistant is configured, each new (non-duplicate) uploaded file fails with `metadata_assistant_unconfigured` before any model request. A missing or invalid model response, a network failure, or a rejected credential produces a clear item error such as `metadata_incomplete`, `metadata_unavailable`, `assistant_unauthorized`, or `assistant_invalid_response`. A malformed or unsupported file fails earlier with its own error.

A failed upload item creates no edition, no file asset, no cover, and no managed blob. The staged upload is discarded when the upload job finishes. Other files in the same upload continue. The failure is not repaired from embedded metadata or by a direct Open Library lookup: uploads have no such fallback. Re-upload the file after fixing the assistant or its answer.

## Manual runs on existing books

An administrator can open a book and choose **Run metadata agent**. This uses the same saved assistant, the same three tools, and the same limits.

The result is a preview, not an immediate change. The preview shows current and proposed values, the source and model name, and a checkbox for each changed field. Proposed changes start selected; deselect any you do not want. Pressing **Apply selected** writes the checked, unlocked fields and locks them. Nothing is applied before that action.

Fields you have locked are marked kept and are never overwritten, even if they appear in the proposal. A manual run also requires a configured assistant; without one the lookup job fails with `metadata_assistant_unconfigured`, with no direct Open Library fallback.

If you select the cover for a manual apply and the cover request fails, the apply fails without writing the confirmed fields. If Open Library simply has no usable cover, the apply succeeds without a new cover. This differs from an upload, where a missing or failed cover is ignored.

## Folder and indexed imports

Folder imports apply to indexed libraries. They read the metadata embedded in each file and commit that metadata. They never call the metadata agent, per file or otherwise, even when an assistant is configured. Rescan and metadata refresh also re-read embedded metadata and do not call the model.

An administrator can still run the agent on an individual imported book with the preview and confirmation flow above. That is a manual action; it does not change how later folder imports behave.

## Covers

The cover proposed by the agent comes from Open Library after a successful submission. Custom covers can also be set from the book page, outside this flow. If Open Library has no usable cover, or the cover request fails during an upload, the edition is still created and no cover image is stored.

The web interface then draws a generated cover fallback: a typographic cover made from the title and author, with a color derived from the title. This fallback is drawn by the client; it is not an image file in the catalog. The OPDS feed links a cover only when an image is actually stored.

## Privacy and operations

The model endpoint is supplied by an administrator and can be remote or local. The metadata in the request leaves the QiJuan server and goes to that endpoint. Do not point it at a provider you do not trust with titles, authors, descriptions, and identifiers. Book text, OCR, and file bytes are not part of that request.

The assistant API key is optional for local servers. When present, it is stored server-side in the mode-`0600` JSON file, sent only in the model request's `Authorization` header, and returned to the settings screen only as a masked hint. The settings routes and manual metadata runs are administrator-only.

Model behavior varies. The agent needs a model that emits tool calls, and a complete proposal can still contain a wrong but plausible field. Uploads commit a validated proposal without a preview, so check newly imported books. For manual runs, the preview and the per-field confirmation are the safety net, and locked fields stay as you set them.

The repository's agent tests use stubbed model and Open Library transports. They do not call DeepSeek, OpenAI, Ollama, or another live model provider, and this document is not a report of a live provider test. A successful **Test connection** only shows that the saved endpoint answered; it does not prove metadata quality or tool support.

See [limitations.md](limitations.md) for what QiJuan does not do, and [development.md](development.md) for where the settings file lives.
