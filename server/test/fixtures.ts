import { deflateSync } from 'node:zlib';
import { buildZip } from '../src/zip.js';

export const EPUB_TITLE = '栖卷试读';
export const EPUB_AUTHOR = '林栖';
export const EPUB_LANGUAGE = 'zh-Hans';
export const EPUB_ID = 'urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f';
export const CHINESE_PARAGRAPH = '书有归处，人有闲读。';
export const ENGLISH_PARAGRAPH = 'A quiet English paragraph sits beside it.';

export const TEXT_PDF_TITLE = '栖卷文本';
export const TEXT_PDF_AUTHOR = 'Ada Lovelace';
export const TEXT_PDF_LANGUAGE = 'en';
export const TEXT_PDF_ID = 'urn:isbn:9780000000002';

export const IMAGE_PDF_TITLE = 'Image Only';

/** 1×1 PNG. Original bytes, not a downloaded cover. */
export const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function buildEpub(options?: {
  identifier?: string;
  english?: string;
  title?: string;
  language?: string;
  author?: string;
  translator?: string | null;
  description?: string | null;
  publisher?: string | null;
  cover?: Buffer;
}): Buffer {
  const identifier = options?.identifier ?? EPUB_ID;
  const english = options?.english ?? ENGLISH_PARAGRAPH;
  const title = options?.title ?? EPUB_TITLE;
  const language = options?.language ?? EPUB_LANGUAGE;
  const author = options?.author ?? EPUB_AUTHOR;
  const translator = options?.translator ?? null;
  const description = options?.description ?? null;
  const publisher = options?.publisher ?? null;
  const cover = options?.cover ?? COVER_PNG;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const metadata = [
    `<dc:identifier id="bookid" opf:scheme="uuid">${xmlEscape(identifier)}</dc:identifier>`,
    `<dc:title>${xmlEscape(title)}</dc:title>`,
    `<dc:language>${xmlEscape(language)}</dc:language>`,
    `<dc:creator opf:role="aut">${xmlEscape(author)}</dc:creator>`,
  ];
  if (translator) metadata.push(`<dc:creator opf:role="trl">${xmlEscape(translator)}</dc:creator>`);
  if (description) metadata.push(`<dc:description>${xmlEscape(description)}</dc:description>`);
  if (publisher) metadata.push(`<dc:publisher>${xmlEscape(publisher)}</dc:publisher>`);
  metadata.push('<meta name="cover" content="cover-image"/>');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metadata.join('\n    ')}
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="chap" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chap"/>
  </spine>
</package>
`;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hans">
  <head><title>${xmlEscape(title)}</title></head>
  <body>
    <p>${CHINESE_PARAGRAPH}</p>
    <p>${english}</p>
  </body>
</html>
`;
  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
    { name: 'META-INF/container.xml', data: Buffer.from(container), method: 0 },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf), method: 8 },
    { name: 'OEBPS/chapter.xhtml', data: Buffer.from(chapter), method: 0 },
    { name: 'OEBPS/cover.png', data: cover, method: 0 },
  ]);
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildTextPdf(): Buffer {
  const text = Buffer.from('BT /F1 24 Tf 72 720 Td (Hello from QiJuan) Tj ET\n', 'utf8');
  const xmp = Buffer.from(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" rdf:about="">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${TEXT_PDF_TITLE}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${TEXT_PDF_AUTHOR}</rdf:li></rdf:Seq></dc:creator>
   <dc:language><rdf:Bag><rdf:li>${TEXT_PDF_LANGUAGE}</rdf:li></rdf:Bag></dc:language>
   <dc:identifier>${TEXT_PDF_ID}</dc:identifier>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`,
    'utf8',
  );
  return assemblePdf(
    [
      Buffer.from('<< /Type /Catalog /Pages 2 0 R /Lang (en) /Metadata 6 0 R >>'),
      Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),
      Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      ),
      streamObject('', text),
      Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
      streamObject('/Type /Metadata /Subtype /XML', xmp),
      Buffer.from(`<< /Title ${pdfUtf16(TEXT_PDF_TITLE)} /Author (${TEXT_PDF_AUTHOR}) >>`),
    ],
    7,
  );
}

export function buildImagePdf(): Buffer {
  const content = Buffer.from('q\n100 0 0 100 50 50 cm\n/Im1 Do\nQ\n', 'utf8');
  const pixels = Buffer.from([0xff, 0x00, 0x00]);
  return assemblePdf(
    [
      Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
      Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),
      Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
      ),
      streamObject('', content),
      streamObject(
        '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8',
        pixels,
      ),
      Buffer.from(`<< /Title (${IMAGE_PDF_TITLE}) >>`),
    ],
    6,
  );
}

/** PDF 1.5 cross-reference stream. Objects themselves are uncompressed. */
export function buildXrefStreamPdf(): Buffer {
  return finishXrefStreamPdf(
    [
      ['1', Buffer.from('<< /Type /Catalog /Pages 2 0 R /Lang (en) >>')],
      ['2', Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>')],
      ['3', Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>')],
      ['5', Buffer.from(`<< /Title ${pdfUtf16(TEXT_PDF_TITLE)} /Author (${TEXT_PDF_AUTHOR}) >>`)],
    ],
    { predict: false },
  );
}

/** Catalog and info live in a compressed object stream, and the xref stream uses PNG prediction. */
export function buildObjectStreamPdf(): Buffer {
  const catalog = Buffer.from('<< /Type /Catalog /Pages 2 0 R /Lang (en) >>');
  const info = Buffer.from(`<< /Title ${pdfUtf16(TEXT_PDF_TITLE)} /Author (${TEXT_PDF_AUTHOR}) >>`);
  const header = `1 0 5 ${catalog.length + 1}\n`;
  const stored = Buffer.concat([Buffer.from(header), catalog, Buffer.from('\n'), info]);
  const compressed = deflateSync(stored);
  const objectStream = Buffer.concat([
    Buffer.from(
      `<< /Type /ObjStm /N 2 /First ${Buffer.byteLength(header)} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    ),
    compressed,
    Buffer.from('\nendstream'),
  ]);
  return finishXrefStreamPdf(
    [
      ['2', Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>')],
      ['3', Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>')],
      ['4', objectStream],
    ],
    { predict: true, compressed: new Set([1, 5]), container: 4 },
  );
}

export function malformedBook(): Buffer {
  return Buffer.from('this is not an epub or a pdf');
}

function finishXrefStreamPdf(
  bodies: Array<[string, Buffer]>,
  options: { predict: boolean; compressed?: Set<number>; container?: number },
): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n')];
  let cursor = parts[0]?.length ?? 0;
  const offsets = new Map<number, number>();
  for (const [number, body] of bodies) {
    offsets.set(Number(number), cursor);
    const chunk = Buffer.concat([Buffer.from(`${number} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    cursor += chunk.length;
  }
  const xrefNumber = 6;
  const xrefOffset = cursor;
  const raw = Buffer.alloc(7 * 7);
  const writeEntry = (index: number, type: number, second: number, third: number) => {
    const at = index * 7;
    raw[at] = type;
    raw.writeUInt32BE(second, at + 1);
    raw.writeUInt16BE(third, at + 5);
  };
  writeEntry(0, 0, 0, 65535);
  for (let number = 1; number <= 5; number += 1) {
    if (options.compressed?.has(number)) {
      writeEntry(number, 2, options.container ?? 0, number === 1 ? 0 : 1);
    } else if (offsets.has(number)) {
      const offset = offsets.get(number);
      if (offset === undefined) throw new Error('missing pdf object offset');
      writeEntry(number, 1, offset, 0);
    } else {
      writeEntry(number, 0, 0, 0);
    }
  }
  writeEntry(xrefNumber, 1, xrefOffset, 0);
  const stored = options.predict ? deflateSync(pngUp(raw, 7)) : raw;
  const filter = options.predict
    ? `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> `
    : '';
  const stream = Buffer.concat([
    Buffer.from(
      `${xrefNumber} 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Info 5 0 R ${filter}/Length ${stored.length} >>\nstream\n`,
    ),
    stored,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`),
  ]);
  parts.push(stream);
  return Buffer.concat(parts);
}

function pngUp(rows: Buffer, columns: number): Buffer {
  const count = rows.length / columns;
  const out = Buffer.alloc(count * (columns + 1));
  let previous = Buffer.alloc(columns);
  for (let row = 0; row < count; row += 1) {
    const current = rows.subarray(row * columns, (row + 1) * columns);
    out[row * (columns + 1)] = 2;
    for (let column = 0; column < columns; column += 1) {
      out[row * (columns + 1) + 1 + column] = ((current[column] ?? 0) - (previous[column] ?? 0)) & 255;
    }
    previous = Buffer.from(current);
  }
  return out;
}

function streamObject(dictInner: string, data: Buffer): Buffer {
  const prefix = dictInner.length > 0 ? `${dictInner} ` : '';
  const head = Buffer.from(`<< ${prefix}/Length ${data.length} >>\nstream\n`);
  return Buffer.concat([head, data, Buffer.from('\nendstream')]);
}

function assemblePdf(objects: Buffer[], infoNumber: number): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let cursor = parts[0]?.length ?? 0;
  objects.forEach((body, index) => {
    offsets.push(cursor);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    cursor += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoNumber} 0 R >>\n` +
    `startxref\n${cursor}\n%%EOF\n`;
  parts.push(Buffer.from(xref + trailer));
  return Buffer.concat(parts);
}

function pdfUtf16(value: string): string {
  const bytes = Buffer.alloc(2 + value.length * 2);
  bytes.writeUInt16BE(0xfeff, 0);
  for (let index = 0; index < value.length; index += 1) {
    bytes.writeUInt16BE(value.charCodeAt(index), 2 + index * 2);
  }
  return `<${bytes.toString('hex')}>`;
}
