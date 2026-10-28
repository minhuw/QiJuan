import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBookFile } from '../src/books.js';
import { BookError } from '../src/metadata.js';
import { buildZip, openZip, ZipError } from '../src/zip.js';
import { makeTempDir } from './helpers.js';
import {
  buildEpub,
  buildImagePdf,
  buildObjectStreamPdf,
  buildTextPdf,
  buildXrefStreamPdf,
  CHINESE_PARAGRAPH,
  COVER_PNG,
  ENGLISH_PARAGRAPH,
  EPUB_AUTHOR,
  EPUB_ID,
  EPUB_LANGUAGE,
  EPUB_TITLE,
  IMAGE_PDF_TITLE,
  malformedBook,
  TEXT_PDF_AUTHOR,
  TEXT_PDF_ID,
  TEXT_PDF_LANGUAGE,
  TEXT_PDF_TITLE,
} from './fixtures.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  return temp.dir;
}

describe('book fixtures', () => {
  it('reads an EPUB with both paragraphs, metadata, and an embedded cover', () => {
    const dir = tempDir();
    const epub = buildEpub();
    const file = path.join(dir, 'tale.epub');
    writeFileSync(file, epub);
    expect(epub.includes(Buffer.from(CHINESE_PARAGRAPH))).toBe(true);
    expect(epub.includes(Buffer.from(ENGLISH_PARAGRAPH))).toBe(true);

    const parsed = parseBookFile('tale.epub', file);
    expect(parsed.title).toBe(EPUB_TITLE);
    expect(parsed.language).toBe(EPUB_LANGUAGE);
    expect(parsed.creators).toEqual([{ name: EPUB_AUTHOR, role: 'author' }]);
    expect(parsed.identifiers).toContainEqual({ scheme: 'uuid', value: EPUB_ID });
    expect(parsed.cover?.mediaType).toBe('image/png');
    expect(parsed.cover?.bytes.equals(COVER_PNG)).toBe(true);
  });

  it('reads a text-layer PDF and an image-only PDF', () => {
    const dir = tempDir();
    const text = buildTextPdf();
    const image = buildImagePdf();
    expect(text.includes(Buffer.from('Tj'))).toBe(true);
    expect(image.includes(Buffer.from('Tj'))).toBe(false);
    expect(image.includes(Buffer.from('/Subtype /Image'))).toBe(true);

    const textPath = path.join(dir, 'text.pdf');
    const imagePath = path.join(dir, 'image.pdf');
    writeFileSync(textPath, text);
    writeFileSync(imagePath, image);

    const parsedText = parseBookFile('text.pdf', textPath);
    expect(parsedText.title).toBe(TEXT_PDF_TITLE);
    expect(parsedText.language).toBe(TEXT_PDF_LANGUAGE);
    expect(parsedText.creators).toEqual([{ name: TEXT_PDF_AUTHOR, role: 'author' }]);
    expect(parsedText.identifiers).toContainEqual({ scheme: 'isbn', value: TEXT_PDF_ID });

    const parsedImage = parseBookFile('image.pdf', imagePath);
    expect(parsedImage.title).toBe(IMAGE_PDF_TITLE);
    expect(parsedImage.cover).toBeNull();
  });

  it('reads a PDF cross-reference stream, including one with an object stream', () => {
    const dir = tempDir();
    const streamPath = path.join(dir, 'stream.pdf');
    const objectPath = path.join(dir, 'objects.pdf');
    writeFileSync(streamPath, buildXrefStreamPdf());
    writeFileSync(objectPath, buildObjectStreamPdf());

    for (const file of [streamPath, objectPath]) {
      const parsed = parseBookFile('book.pdf', file);
      expect(parsed.title).toBe(TEXT_PDF_TITLE);
      expect(parsed.language).toBe(TEXT_PDF_LANGUAGE);
      expect(parsed.creators).toEqual([{ name: TEXT_PDF_AUTHOR, role: 'author' }]);
    }
  });

  it('fails a malformed book and does not unzip anything except a recognized EPUB', () => {
    const dir = tempDir();
    const broken = path.join(dir, 'broken.epub');
    writeFileSync(broken, malformedBook());
    expect(() => parseBookFile('broken.epub', broken)).toThrow(BookError);

    const outside = path.join(dir, 'outside.txt');
    const slipped = buildZip(
      [
        { name: 'mimetype', data: Buffer.from('application/epub+zip') },
        { name: '../outside.txt', data: Buffer.from('secret') },
      ],
      { allowUnsafe: true },
    );
    const slipPath = path.join(dir, 'slip.epub');
    writeFileSync(slipPath, slipped);
    expect(() => parseBookFile('slip.epub', slipPath)).toThrow(BookError);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(path.resolve(dir, '..', 'outside.txt'))).toBe(false);

    const notEpub = buildZip([
      { name: 'mimetype', data: Buffer.from('application/zip') },
      { name: 'secret.txt', data: Buffer.from('secret') },
    ]);
    const fake = path.join(dir, 'fake.epub');
    writeFileSync(fake, notEpub);
    try {
      parseBookFile('fake.epub', fake);
      expect.fail('expected malformed');
    } catch (error) {
      expect(error).toBeInstanceOf(BookError);
      expect((error as BookError).code).toBe('malformed');
    }

    const trap = path.join(dir, 'trap.pdf');
    writeFileSync(trap, notEpub);
    try {
      parseBookFile('trap.pdf', trap);
      expect.fail('expected malformed pdf');
    } catch (error) {
      expect(error).toBeInstanceOf(BookError);
      expect((error as BookError).code).toBe('malformed');
    }
    try {
      parseBookFile('notes.txt', trap);
      expect.fail('expected unsupported');
    } catch (error) {
      expect(error).toBeInstanceOf(BookError);
      expect((error as BookError).code).toBe('unsupported');
    }
    expect(existsSync(outside)).toBe(false);
  });

  it('rejects a claimed central directory that does not fit in the file', () => {
    const dir = tempDir();
    const claims = [
      { cdSize: 0x40000000, cdOffset: 0 },
      { cdSize: 0xffffffff, cdOffset: 0 },
      { cdSize: 32, cdOffset: 48 },
    ];
    for (const claim of claims) {
      const bytes = eocdBomb(claim.cdSize, claim.cdOffset);
      const file = path.join(dir, `bomb-${claim.cdSize.toString(16)}-${claim.cdOffset}.epub`);
      writeFileSync(file, bytes);
      const original = Buffer.alloc;
      const sizes: number[] = [];
      let caught: unknown;
      Buffer.alloc = ((size: number) => {
        sizes.push(size);
        if (size > bytes.length) throw new Error(`allocated ${size}`);
        return original(size);
      }) as typeof Buffer.alloc;
      try {
        openZip(file);
      } catch (error) {
        caught = error;
      } finally {
        Buffer.alloc = original;
      }
      expect(caught).toBeInstanceOf(ZipError);
      expect((caught as ZipError).code).toBe('invalid');
      expect(sizes.every((size) => size <= bytes.length)).toBe(true);
      expect(() => parseBookFile(path.basename(file), file)).toThrow(BookError);
    }
  });
});

/** Tiny end-of-central-directory record with an attacker-controlled directory size. */
function eocdBomb(cdSize: number, cdOffset: number): Buffer {
  const bytes = Buffer.alloc(64);
  const index = bytes.length - 22;
  bytes.writeUInt32LE(0x06054b50, index);
  bytes.writeUInt16LE(1, index + 10);
  bytes.writeUInt32LE(cdSize, index + 12);
  bytes.writeUInt32LE(cdOffset, index + 16);
  return bytes;
}
