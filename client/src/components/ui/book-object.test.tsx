import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BOOK_ASPECT, BookObject, coverFit } from './book-object';

/** Loads the rendered cover as if it were `width` × `height` pixels. */
function loadCover(container: HTMLElement, width: number, height: number) {
  const image = container.querySelector('img.cover-image') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
  act(() => {
    image.dispatchEvent(new Event('load'));
  });
}

const book = (id: number, hasCover = true) => ({ id, title: '康德《纯粹理性批判》句读（上）', authors: ['邓晓芒'], hasCover });

describe('cover fit', () => {
  it('fills the book shape when a cover is close to it, and shows it whole when not', () => {
    expect(BOOK_ASPECT).toBe(1.4);
    // Douban covers at 357×500 and 407×582: filled, the trim is a pixel or two.
    expect(coverFit(500 / 357)).toBeNull();
    expect(coverFit(582 / 407)).toBeNull();
    // A photo of a boxed set at 308×500 keeps its full height and narrows.
    expect(coverFit(500 / 308)).toBeCloseTo(0.862, 3);
    // A wide cover keeps the full width and is shorter.
    expect(coverFit(1)).toBe(1);
    expect(coverFit(Number.NaN)).toBeNull();
    expect(coverFit(0)).toBeNull();
  });

  it('narrows a tall cover once it loads, and keeps that shape when the book remounts', () => {
    const first = render(<BookObject book={book(9001)} size="shelf" />);
    const object = first.container.querySelector('.book-object') as HTMLElement;
    expect(object.className).toBe('book-object book-object-shelf');
    loadCover(first.container, 308, 500);
    expect(object.className).toBe('book-object book-object-shelf book-object-whole');
    expect(object.style.width).toBe('86.24%');
    first.unmount();

    const again = render(<BookObject book={book(9001)} size="mini" />);
    expect((again.container.querySelector('.book-object') as HTMLElement).style.width).toBe('86.24%');
  });

  it('leaves a cover near the shape, and a drawn cover, filling it', () => {
    const near = render(<BookObject book={book(9002)} size="shelf" />);
    loadCover(near.container, 357, 500);
    const object = near.container.querySelector('.book-object') as HTMLElement;
    expect(object.className).toBe('book-object book-object-shelf');
    expect(object.getAttribute('style')).toBeNull();

    const drawn = render(<BookObject book={book(9003, false)} size="shelf" />);
    expect(drawn.container.querySelector('img')).toBeNull();
    expect(drawn.container.querySelector('.book-object')!.className).toBe('book-object book-object-shelf');
  });
});
