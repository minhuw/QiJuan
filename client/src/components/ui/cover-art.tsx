import { useCallback } from 'react';

const PLATES = ['vermilion', 'ultramarine', 'emerald', 'ochre', 'umber', 'plum', 'teal'] as const;
const CJK_ONLY = /^[\p{Script=Han}\u3000-\u303f\uff00-\uffef\u00b7\u30fb]+$/u;

function plateFor(editionId: number): (typeof PLATES)[number] {
  const index = Math.abs(Math.trunc(editionId)) % PLATES.length;
  return PLATES[index] ?? 'umber';
}

function setsVertically(title: string): boolean {
  const trimmed = title.trim();
  return CJK_ONLY.test(trimmed) && Array.from(trimmed).length <= 8;
}

export function CoverArt({
  editionId,
  title,
  author,
  hasCover,
  variant = 'card',
  eager = false,
  onImage,
}: {
  editionId: number;
  title: string;
  author?: string;
  hasCover: boolean;
  variant?: 'card' | 'detail' | 'thumb';
  eager?: boolean;
  /** Called with the cover image once it has loaded. */
  onImage?: (image: HTMLImageElement) => void;
}) {
  const vertical = setsVertically(title);
  // An image already in the cache may finish before React sees its load event.
  const loadedRef = useCallback(
    (image: HTMLImageElement | null) => {
      if (image?.complete && onImage) onImage(image);
    },
    [onImage],
  );
  return (
    <span className={`plate cover-art cover-art-${variant}`}>
      {hasCover ? (
        <img
          className="cover-image"
          alt=""
          src={`/api/editions/${editionId}/cover`}
          loading={eager ? undefined : 'lazy'}
          decoding="async"
          onLoad={onImage ? (event) => onImage(event.currentTarget) : undefined}
          ref={loadedRef}
        />
      ) : (
        <span className={`cover-fallback plate-${plateFor(editionId)}`}>
          <span
            className={vertical ? 'cover-fallback-title cover-fallback-title-vertical' : 'cover-fallback-title'}
            lang={vertical ? 'zh-Hans' : undefined}
          >
            {title}
          </span>
          {author ? <span className="cover-fallback-author">{author}</span> : null}
        </span>
      )}
    </span>
  );
}
