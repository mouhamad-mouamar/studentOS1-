const path = require('path');
const { extractText } = require(path.join(__dirname, '..', 'dist-server', 'extract.js'));

// Minimal valid uncompressed PDF
const lines = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  '4 0 obj<</Length 120>>stream',
  'BT /F1 18 Tf 72 720 Td (The integral of velocity gives displacement. This is very important.) Tj ET',
  'endstream endobj',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  'trailer<</Root 1 0 R/Size 6>>',
  '%%EOF',
];
const pdf = Buffer.from(lines.join('\n'), 'latin1');

extractText('pdf', pdf).then((r) => {
  const ok = r.text && r.text.includes('integral of velocity');
  console.log('PDF text:', JSON.stringify((r.text || '').slice(0, 100)));
  console.log('PDF ok:', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}).catch((e) => { console.error('PDF FAIL:', e.message); process.exit(1); });
