// Regenerate PWA icons in the champagne-gold brand (drawn with @napi-rs/canvas).
const { createCanvas, Path2D } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

function render(size, out) {
  const s = size / 64; // scale from the 64-unit design grid
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // near-black rounded card
  const r = 16 * s;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fillStyle = '#101014';
  ctx.fill();

  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#e6d09c');
  grad.addColorStop(0.55, '#c9a86a');
  grad.addColorStop(1, '#a5813c');

  // subtle inner gold ring
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 29 * s, 0, Math.PI * 2);
  ctx.strokeStyle = grad;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // mortarboard + band (same geometry as the logo mark)
  const cap = new Path2D('M32 14 L50 23 L32 32 L14 23 Z');
  const band = new Path2D('M21.5 28.5v9.5c0 3.6 4.7 6.5 10.5 6.5s10.5-2.9 10.5-6.5v-9.5L32 34Z');
  ctx.save();
  ctx.scale(s, s);
  ctx.fillStyle = grad;
  ctx.fill(cap);
  ctx.globalAlpha = 0.85;
  ctx.fill(band);
  ctx.restore();

  fs.writeFileSync(path.join(__dirname, '..', 'public', out), canvas.toBuffer('image/png'));
  console.log('wrote', out);
}

render(192, 'icon-192.png');
render(512, 'icon-512.png');
render(180, 'apple-touch-icon.png');
