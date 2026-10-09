// Builds a minimal valid one-page PDF with an embedded image XObject and
// text, to exercise pdf-parse/pdf.js image-transform paths (DOMMatrix).
// Usage: node scripts/make-diag-pdf.cjs scripts/diag-image.pdf
const fs = require('fs');

const W = 595, H = 842; // A4 points
const imgW = 2, imgH = 2;
// 2x2 RGB bitmap: red, blue, green, white
const raw = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255]);
const hex = raw.toString('hex').toUpperCase();

const content = `BT /F1 12 Tf 50 780 Td (Chapter 1 Kinematics. Velocity is the derivative of position.) Tj ET\nq ${200} 0 0 ${200} 50 500 cm /Im1 Do Q\n`;

const objects = [];
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 4 0 R >> >> /Contents 6 0 R >>`);
objects.push(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length + 1} >>\nstream\n${hex}>\nendstream`);
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);

let out = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(out.length);
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = out.length;
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

fs.writeFileSync(process.argv[2] || 'scripts/diag-image.pdf', out, 'latin1');
console.log('written', process.argv[2] || 'scripts/diag-image.pdf', out.length, 'bytes');
