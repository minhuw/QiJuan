# Annotation export

A signed-in user can download the highlights and notes they wrote on one book. The file contains that user's annotations only. Another account that can open the same library gets the book title and authors, and empty highlight and note lists. A request without a session is rejected.

On the book page, use the Markdown or JSON export link. The same requests are:

```http
GET /api/editions/:editionId/annotations?format=markdown
GET /api/editions/:editionId/annotations?format=json
```

The session cookie is required. The account must be allowed to read the book's library. `format` must be `markdown` or `json`.

Markdown is `text/markdown; charset=utf-8`, downloaded as `annotations.md`. It is a note you can keep beside the book, including in a folder of Markdown files: YAML front matter with `title` and `authors`, a heading for the book, then one `## Highlight` or `## Note` section. Each section has the saved text and, when the annotation has one, a `Location:` line with the locator.

JSON is `application/json; charset=utf-8`, downloaded as `annotations.json`:

```json
{
  "book": {
    "id": 1,
    "title": "栖卷试读",
    "authors": ["林栖"],
    "identifiers": [{ "scheme": "uuid", "value": "urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f" }]
  },
  "highlights": [{ "text": "书有归处，人有闲读。", "locator": "epubcfi(/6/2)" }],
  "notes": [{ "text": "A quiet English paragraph sits beside it.", "locator": "epubcfi(/6/4)" }]
}
```

A note that was not tied to a place has `"locator": null`. Highlights and notes are ordered by the time they were created, then by id. Bookmarks and the reading position are not in this export.

The OPDS catalog does not include this file, and it does not synchronize reading progress. See [opds.md](opds.md).
