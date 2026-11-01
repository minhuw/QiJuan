import { api, type EditionDetail, type LibraryEdition, type ReadingStatus } from './api';

/** The card fields a reading or shelf change can alter, read back from the edition the server returns. */
export function cardPatch(edition: EditionDetail): Partial<LibraryEdition> {
  const reading = edition.reading;
  if (!reading) return {};
  return {
    status: reading.status,
    rating: reading.rating,
    favorite: reading.favorite,
    shelfIds: reading.shelves.filter((shelf) => shelf.included).map((shelf) => shelf.id),
  };
}

type Result = { patch: Partial<LibraryEdition> } | { error: string };

async function settle(request: Promise<{ data?: { edition: EditionDetail } | null; error?: string | null }>): Promise<Result> {
  const result = await request;
  if (result.error || !result.data?.edition) return { error: result.error ?? 'network' };
  return { patch: cardPatch(result.data.edition) };
}

export function setStatus(editionId: number, status: ReadingStatus | null): Promise<Result> {
  return settle(api<{ edition: EditionDetail }>(`/api/editions/${editionId}/reading`, { method: 'PATCH', body: { status } }));
}

export function setFavorite(editionId: number, favorite: boolean): Promise<Result> {
  return settle(api<{ edition: EditionDetail }>(`/api/editions/${editionId}/reading`, { method: 'PATCH', body: { favorite } }));
}

export function setOnShelf(editionId: number, shelfId: number, on: boolean): Promise<Result> {
  return settle(
    on
      ? api<{ edition: EditionDetail }>(`/api/shelves/${shelfId}/items`, { method: 'POST', body: { editionId } })
      : api<{ edition: EditionDetail }>(`/api/shelves/${shelfId}/items/${editionId}`, { method: 'DELETE' }),
  );
}
