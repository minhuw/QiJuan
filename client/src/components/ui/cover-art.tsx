import type { CSSProperties } from 'react';

function coverHue(title: string): number {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  return hash;
}

export function CoverArt({
  editionId,
  title,
  author,
  hasCover,
  variant = 'card',
  eager = false,
}: {
  editionId: number;
  title: string;
  author?: string;
  hasCover: boolean;
  variant?: 'card' | 'detail' | 'thumb';
  eager?: boolean;
}) {
  const style = { '--cover-hue': coverHue(title) } as CSSProperties;
  return (
    <span className={`cover-art cover-art-${variant}`} style={style}>
      {hasCover ? (
        <img
          className="cover-image"
          alt=""
          src={`/api/editions/${editionId}/cover`}
          loading={eager ? undefined : 'lazy'}
          decoding="async"
        />
      ) : (
        <span className="cover-fallback">
          <span className="cover-fallback-rule" aria-hidden="true" />
          <span className="cover-fallback-title">{title}</span>
          {author ? <span className="cover-fallback-author">{author}</span> : null}
          <span className="cover-fallback-mark" lang="zh-Hans" aria-hidden="true">
            栖卷
          </span>
        </span>
      )}
    </span>
  );
}
