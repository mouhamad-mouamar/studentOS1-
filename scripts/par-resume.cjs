// Resume partial part-N files from a par-download run. Appends from each
// part's current size with socket-timeout retry.
const https = require('https');
const fs = require('fs');
const path = require('path');
const DIR = 'C:\\Users\\Thinkpad\\AppData\\Local\\Temp\\studyos-ai';
const URL_ = process.argv[2];
const CONNS = Number(process.argv[3] || 10);

function head(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) return resolve(head(res.headers.location));
      resolve({ len: Number(res.headers['content-length'] || 0) });
      res.resume();
    });
    req.on('error', reject);
    req.end();
  });
}

function rangeAppend(url, start, end, file) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      const req = https.get(u, { headers: { Range: `bytes=${start}-${end}` } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 206) return reject(new Error(`status ${res.statusCode}`));
        const ws = fs.createWriteStream(file, { flags: 'a' });
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      req.setTimeout(20000, () => req.destroy(new Error('socket timeout')));
      req.on('error', reject);
    };
    get(url);
  });
}

(async () => {
  const { len } = await head(URL_);
  const chunk = Math.ceil(len / CONNS);
  let pending = [];
  for (let i = 0; i < CONNS; i++) {
    const start = i * chunk;
    const end = Math.min(len - 1, start + chunk - 1);
    if (start > end) break;
    const f = path.join(DIR, `part-${i}`);
    const have = fs.existsSync(f) ? fs.statSync(f).size : 0;
    const want = end - start + 1;
    if (have >= want) continue;
    pending.push({ i, from: start + have, to: end, f, need: want - have });
  }
  console.log(`total ${(len / 1e6).toFixed(1)}MB; parts to resume: ${pending.map((p) => p.i).join(',')}`);
  let done = 0;
  await Promise.all(
    pending.map(async (p) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const have = fs.existsSync(p.f) ? fs.statSync(p.f).size : 0;
        const from = p.i * chunk + have;
        if (from > p.to) break;
        try {
          await rangeAppend(URL_, from, p.to, p.f);
          break;
        } catch (e) {
          console.log(`part ${p.i} retry ${attempt + 1}: ${e.message}`);
        }
      }
      done++;
      console.log(`part ${p.i} finished (${done}/${pending.length})`);
    }),
  );
  // verify + assemble
  const ok = [];
  for (let i = 0; i < CONNS; i++) {
    const start = i * chunk;
    const end = Math.min(len - 1, start + chunk - 1);
    if (start > end) break;
    const f = path.join(DIR, `part-${i}`);
    const want = end - start + 1;
    const have = fs.statSync(f).size;
    if (have < want) {
      console.error(`part ${i} INCOMPLETE: ${have}/${want}`);
      process.exit(2);
    }
    ok.push(f);
  }
  const out = path.join(DIR, process.argv[4] || 'qwen05b.gguf');
  const ws = fs.createWriteStream(out);
  for (const f of ok) {
    await new Promise((res) => {
      const rs = fs.createReadStream(f);
      rs.pipe(ws, { end: false });
      rs.on('end', res);
    });
  }
  await new Promise((res) => ws.end(res));
  console.log('ASSEMBLED', (fs.statSync(out).size / 1e6).toFixed(1) + 'MB');
  for (const f of ok) fs.unlinkSync(f);
  console.log('DONE');
})();
