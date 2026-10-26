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

export function buildEpub(options?: { identifier?: string; english?: string }): Buffer {
  const identifier = options?.identifier ?? EPUB_ID;
  const english = options?.english ?? ENGLISH_PARAGRAPH;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid" opf:scheme="uuid">${identifier}</dc:identifier>
    <dc:title>${EPUB_TITLE}</dc:title>
    <dc:language>${EPUB_LANGUAGE}</dc:language>
    <dc:creator opf:role="aut">${EPUB_AUTHOR}</dc:creator>
    <meta name="cover" content="cover-image"/>
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
  <head><title>${EPUB_TITLE}</title></head>
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
    { name: 'OEBPS/cover.png', data: COVER_PNG, method: 0 },
  ]);
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

export function malformedBook(): Buffer {
  return Buffer.from('this is not an epub or a pdf');
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
