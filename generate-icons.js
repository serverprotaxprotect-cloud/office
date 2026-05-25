// Run once: node generate-icons.js
// Generates PWA PNG icons in public/icons/
const { Jimp } = require('jimp');
const path = require('path');

const NAVY   = 0x1e3a8aff; // #1e3a8a
const WHITE  = 0xffffffff;
const BLUE   = 0x60a5faff; // accent

async function makeIcon(size) {
  const img = new Jimp({ width: size, height: size, color: NAVY });
  const cx  = size / 2;
  const cy  = size * 0.45;
  const r   = size * 0.33;
  const lw  = Math.max(2, Math.round(size * 0.04));

  // Draw circle (clock outline)
  drawCircle(img, cx, cy, r, lw, WHITE);

  // Hour hand (12 o'clock direction)
  drawLine(img, cx, cy, cx, cy - r * 0.58, lw, WHITE);

  // Minute hand (~3:30 direction)
  drawLine(img, cx, cy, cx + r * 0.42, cy + r * 0.22, Math.max(2, lw - 2), BLUE);

  // Center dot
  fillCircle(img, cx, cy, lw * 1.4, BLUE);

  // Bottom accent bar
  const barW  = size * 0.44;
  const barH  = size * 0.055;
  const barY  = size * 0.82;
  fillRect(img, cx - barW / 2, barY, barW, barH, BLUE);

  return img;
}

function drawCircle(img, cx, cy, r, thickness, color) {
  for (let angle = 0; angle < 360; angle += 0.3) {
    const rad = angle * Math.PI / 180;
    for (let t = -thickness / 2; t <= thickness / 2; t++) {
      const x = Math.round(cx + (r + t) * Math.cos(rad));
      const y = Math.round(cy + (r + t) * Math.sin(rad));
      if (x >= 0 && x < img.bitmap.width && y >= 0 && y < img.bitmap.height)
        img.setPixelColor(color, x, y);
    }
  }
}

function drawLine(img, x0, y0, x1, y1, thickness, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps;
    const y = y0 + (y1 - y0) * i / steps;
    for (let dx = -thickness / 2; dx <= thickness / 2; dx++) {
      for (let dy = -thickness / 2; dy <= thickness / 2; dy++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px >= 0 && px < img.bitmap.width && py >= 0 && py < img.bitmap.height)
          img.setPixelColor(color, px, py);
      }
    }
  }
}

function fillCircle(img, cx, cy, r, color) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (dx * dx + dy * dy <= r * r) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x >= 0 && x < img.bitmap.width && y >= 0 && y < img.bitmap.height)
          img.setPixelColor(color, x, y);
      }
    }
  }
}

function fillRect(img, x, y, w, h, color) {
  for (let px = x; px < x + w; px++) {
    for (let py = y; py < y + h; py++) {
      if (px >= 0 && px < img.bitmap.width && py >= 0 && py < img.bitmap.height)
        img.setPixelColor(color, Math.round(px), Math.round(py));
    }
  }
}

(async () => {
  console.log('Generating icons...');
  for (const size of [192, 512]) {
    const img  = await makeIcon(size);
    const file = path.join(__dirname, `public/icons/icon-${size}.png`);
    await img.write(file);
    console.log(`✓ icon-${size}.png`);
  }
  console.log('Done!');
})();
