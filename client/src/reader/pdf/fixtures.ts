/** Hand-built PDFs for the reader. No network, no fonts beyond Helvetica. */

function buildPdf(objects: string[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const push = (text: string) => chunks.push(ascii(text));
  push('%PDF-1.4\n');
  let size = chunks[0]?.length ?? 0;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(size);
    const bytes = ascii(object.endsWith('\n') ? object : `${object}\n`);
    chunks.push(bytes);
    size += bytes.length;
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  push(xref);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function stream(header: string, data: string): string {
  return `<< ${header} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
}

/** A one-page scan: an image XObject and no text operators. */
export function imageOnlyPdf(): Uint8Array {
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    `4 0 obj\n${stream(
      '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode',
      '80>',
    )}`,
    `5 0 obj\n${stream('', 'q 100 0 0 100 40 40 cm /Im1 Do Q')}`,
  ]);
}

/** Text, no outline, no embedded thumbnail. */
export function plainTextPdf(): Uint8Array {
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n${stream('', 'BT /F1 18 Tf 40 200 Td (Plain page) Tj ET')}`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]);
}

/** Two text pages and an outline pointing at the first page. */
export function outlineTextPdf(): Uint8Array {
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 2 /Kids [3 0 R 8 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n${stream('', 'BT /F1 24 Tf 72 300 Td (Hello QiJuan) Tj ET')}`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n',
    '7 0 obj\n<< /Title (Chapter One) /Parent 6 0 R /Dest [3 0 R /XYZ 10 350 0] >>\nendobj\n',
    '8 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 9 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `9 0 obj\n${stream('', 'BT /F1 18 Tf 40 200 Td (Second) Tj ET')}`,
  ]);
}
