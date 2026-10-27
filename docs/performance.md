# Performance

Measured by `server/test/acceptance/performance.test.ts`. That test is not part of `npm test`. It inserts the dataset below, warms one call, then times the next call. Both warmed calls must finish in under 2 seconds.

## Dataset

10,000 synthetic editions in one managed library. Each edition has one author, chosen from 200 author names, and two tags. Titles, authors, and tags are stored in the catalog tables (`editions`, `persons`, `edition_contributors`, and `tags`). The inserts use that schema, including the triggers from `server/migrations/0007_search.sql` that maintain the FTS5 trigram index `edition_fts`. No book file bytes are stored. One title is `山海闲读`. The other titles are `性能测试第NNNNN卷`.

## Environment

- Node.js: v22.23.4
- CPU architecture (`process.arch`): x64

## Timings

| Call | Answer | Time |
| --- | --- | --- |
| Warmed first library page (`searchLibrary`, no query, limit 24, offset 0) | 10,000 editions, first page of 24 | 9.8 ms |
| Warmed title search for `山海闲读` | 1 hit(s) | 12.9 ms |

Both warmed calls were under 2 seconds.

## Indexed queries

The first page reads the covering index `editions_library_sort_idx` (library, trash flag, sort title, id):

```
SEARCH e USING COVERING INDEX editions_library_sort_idx (library_id=? AND trashed_at=?)
```

The title search matches the FTS5 index `edition_fts` (trigram), which is the same predicate `searchLibrary` uses for a query of three characters or more:

```
SEARCH e USING COVERING INDEX editions_library_sort_idx (library_id=? AND trashed_at=?)
LIST SUBQUERY 1
SCAN edition_fts VIRTUAL TABLE INDEX 0:M7
CREATE BLOOM FILTER
```
