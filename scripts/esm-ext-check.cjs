// Final ESM audit: every local relative import in server/ and api/ must end
// with .js (Node ESM on Vercel requires explicit extensions).
const fs = require('fs');
const path = require('path');
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
let bad = 0;
for (const dir of ['server', 'api']) {
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      if (!m[1].endsWith('.js')) {
        console.log('MISSING .js:', f, '->', m[1]);
        bad++;
      }
    }
  }
}
console.log(bad === 0 ? 'ESM EXTENSION CHECK: ALL LOCAL IMPORTS END WITH .js' : bad + ' problems');
process.exit(bad === 0 ? 0 : 1);
