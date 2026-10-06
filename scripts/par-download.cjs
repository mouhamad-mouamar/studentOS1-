// Parallel ranged download (HF CDN throttles per connection).
const https = require('https');
const fs = require('fs');
const path = require('path');

const URL_ = process.argv[2];
const OUT = process.argv[3];
const CONNS = Number(process.argv[4] || 8);

function head(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        resolve(head(res.headers.location));
      } else {
        resolve({ len: Number(res.headers['content-length'] || 0), acceptRanges: res.headers['accept-ranges'] === 'bytes' });
        res.resume();
      }
    });
    req.on('error', reject);
    req.end();
  });
}

function range(url, start, end, file, idx) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      const req = https.get(u, { headers: { Range: `bytes=${start}-${end}` } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 206) return reject(new Error(`status ${res.statusCode}`));
        const ws = fs.createWriteStream(file, { start: 0, flags: 'w' });
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      req.on('error', reject);
    };
    get(url);
  });
}

(async () => {
  const { len } = await head(URL_);
  if (!len) throw new Error('no content-length');
  console.log(`total ${(len / 1e6).toFixed(0)}MB, ${CONNS} connections`);
  const chunk = Math.ceil(len / CONNS);
  const parts = [];
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < CONNS; i++) {
    const start = i * chunk;
    const end = Math.min(len - 1, start + chunk - 1);
    if (start > end) break;
    const f = path.join(path.dirname(OUT), `part-${i}`);
    parts.push({ f, start });
    range(URL_, start, end, f, i)
      .then(() => {
        done++;
        const got = parts.length * (chunk / 1e6);
        console.log(`part ${i} done (${done}/${CONNS})`);
      })
      .catch((e) => {
        console.error(`part ${i} FAILED:`, e.message);
        process.exitCode = 2;
      });
  }
  const timer = setInterval(() => {
    let bytes = 0;
    for (const p of parts) {
      try { bytes += fs.statSync(p.f).size; } catch {}
    }
    const rate = bytes / ((Date.now() - t0) / 1000) / 1e6;
    console.log(`${(bytes / 1e6).toFixed(1)}MB / ${(len / 1e6).toFixed(0)}MB — ${rate.toFixed(2)} MB/s`);
    if (done >= CONNS || process.exitCode === 2) clearInterval(timer);
  }, 5000);
  const all = () => done >= CONNS;
  while (!all() && process.exitCode !== 2) await new Promise((r) => setTimeout(r, 1000));
  if (process.exitCode === 2) process.exit(2);
  const ws = fs.createWriteStream(OUT);
  for (const p of parts) {
    await new Promise((res) => {
      const rs = fs.createReadStream(p.f);
      rs.pipe(ws, { end: false });
      rs.on('end', res);
    });
    fs.unlinkSync(p.f);
  }
  await new Promise((res) => ws.end(res));
  console.log('ASSEMBLED', (fs.statSync(OUT).size / 1e6).toFixed(1) + 'MB');
})();
