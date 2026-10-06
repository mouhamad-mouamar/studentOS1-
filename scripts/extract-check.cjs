// Test extract.ts text extraction for pptx/docx with synthetic files.
const JSZip = require('jszip');
const path = require('path');
const tsx = path.join(__dirname, '..', 'dist-server', 'extract.js');

(async () => {
  const { extractText } = require(tsx);

  // PPTX: minimal valid structure
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld><p:txBody><a:p><a:r><a:t>Integration by Parts</a:t></a:r></a:p></p:txBody></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld><p:txBody><a:p><a:r><a:t>This is very important for the exam</a:t></a:r></a:p></p:txBody></p:sld>');
  const pptxBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const pptx = await extractText('pptx', pptxBuf);
  console.log('PPTX text:', JSON.stringify(pptx.text.slice(0, 120)));
  console.log('PPTX ok:', pptx.text.includes('Integration by Parts') && pptx.text.includes('[Slide 2]'));

  // DOCX: minimal valid structure
  const zip2 = new JSZip();
  zip2.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The chain rule states that dy/dx = dy/du * du/dx.</w:t></w:r></w:p></w:body></w:document>');
  const docxBuf = await zip2.generateAsync({ type: 'nodebuffer' });
  const docx = await extractText('docx', docxBuf);
  console.log('DOCX text:', JSON.stringify(docx.text.slice(0, 120)));
  console.log('DOCX ok:', docx.text.includes('chain rule'));

  // TXT
  const txt = await extractText('text', Buffer.from('hello world, this is important'));
  console.log('TXT ok:', txt.text.includes('hello world'));

  // emphasis scan
  const { findEmphasis } = require(tsx);
  const em = findEmphasis('This is very important for your understanding. The sky is blue. This will be on the exam!');
  console.log('emphasis hits:', em.length, em.length === 2 ? 'OK' : 'CHECK');
})();
