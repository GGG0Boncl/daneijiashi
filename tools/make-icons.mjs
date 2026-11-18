#!/usr/bin/env node
/**
 * 生成 App 图标：朱砂底 + 米色篆印「国」。
 *
 * 为什么手写 PNG 编码：本机不想再引入 canvas 类依赖，
 * zlib 是 Node 自带的，CRC32 二十行搞定，生成出来的图标完全可复现。
 *
 * 用法：node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'app', 'android', 'app', 'src', 'main', 'res');

const SEAL = [0x9e, 0x2b, 0x25]; // 朱砂
const CREAM = [0xf3, 0xe8, 0xd4]; // 米色印文
const PAPER = [0xed, 0xe4, 0xd3]; // 宣纸（圆角描边）

/* ------------------------- 最小 PNG 编码 ------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------- 画图工具 ------------------------- */

function makeCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function setPx(cv, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= cv.size || y >= cv.size) return;
  const i = (y * cv.size + x) * 4;
  cv.data[i] = r;
  cv.data[i + 1] = g;
  cv.data[i + 2] = b;
  cv.data[i + 3] = a;
}

function blendPx(cv, x, y, [r, g, b], a = 255, alphaMul = 1) {
  if (x < 0 || y < 0 || x >= cv.size || y >= cv.size) return;
  const i = (y * cv.size + x) * 4;
  const a0 = (cv.data[i + 3] / 255) * alphaMul;
  const a1 = a / 255;
  const out = a0 + a1 * (1 - a0);
  if (out <= 0) return;
  cv.data[i] = Math.round((cv.data[i] * a0 + r * a1 * (1 - a0)) / out);
  cv.data[i + 1] = Math.round((cv.data[i + 1] * a0 + g * a1 * (1 - a0)) / out);
  cv.data[i + 2] = Math.round((cv.data[i + 2] * a0 + b * a1 * (1 - a0)) / out);
  cv.data[i + 3] = Math.round(out * 255);
}

/** 超采样抗锯齿的圆角矩形填充 */
function roundRect(cv, x0, y0, w, h, radius, color, alphaMul = 1) {
  const S = cv.size;
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          if (px < x0 || py < y0 || px >= x0 + w || py >= y0 + h) continue;
          const dx = Math.min(px - x0, x0 + w - px);
          const dy = Math.min(py - y0, y0 + h - py);
          if (dx < radius && dy < radius) {
            const ddx = radius - dx;
            const ddy = radius - dy;
            if (ddx * ddx + ddy * ddy > radius * radius) continue;
          }
          hits += 1;
        }
      }
      if (hits) blendPx(cv, x, y, color, 255, (hits / 9) * alphaMul);
    }
  }
  void S;
}

function circle(cv, cx, cy, r, color, alphaMul = 1) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3 - cx;
          const py = y + (sy + 0.5) / 3 - cy;
          if (px * px + py * py <= r * r) hits += 1;
        }
      }
      if (hits) blendPx(cv, x, y, color, 255, (hits / 9) * alphaMul);
    }
  }
}

/** 用圆点笔刷画粗线（模拟篆刻笔画，端点是圆的） */
function stub(cv, x0, y0, x1, y1, width, color, alphaMul = 1) {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    circle(cv, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color, alphaMul);
  }
}

/**
 * 画印章：囗（外框）+ 王（三横一竖）+ 一丶
 * 以 size 为基准，inside 表示"印面可用的边长比例"
 */
function drawSeal(cv, { cx, cy, side, alphaMul = 1 }) {
  const x0 = cx - side / 2;
  const y0 = cy - side / 2;
  const t = side * 0.1; // 笔画粗细
  const inset = side * 0.06;

  // 外框（囗）
  stub(cv, x0, y0, x0 + side, y0, t, CREAM, alphaMul);
  stub(cv, x0, y0 + side, x0 + side, y0 + side, t, CREAM, alphaMul);
  stub(cv, x0, y0, x0, y0 + side, t, CREAM, alphaMul);
  stub(cv, x0 + side, y0, x0 + side, y0 + side, t, CREAM, alphaMul);

  // 内框（给"王"留白，形成双框的印味）
  const inSide = side - inset * 2;
  const ix0 = x0 + inset;
  const iy0 = y0 + inset;
  stub(cv, ix0, iy0, ix0 + inSide, iy0, t * 0.5, CREAM, alphaMul * 0.9);
  stub(cv, ix0, iy0 + inSide, ix0 + inSide, iy0 + inSide, t * 0.5, CREAM, alphaMul * 0.9);
  stub(cv, ix0, iy0, ix0, iy0 + inSide, t * 0.5, CREAM, alphaMul * 0.9);
  stub(cv, ix0 + inSide, iy0, ix0 + inSide, iy0 + inSide, t * 0.5, CREAM, alphaMul * 0.9);

  // 王：三横一竖
  const wx0 = x0 + side * 0.3;
  const wx1 = x0 + side * 0.7;
  const wy = [y0 + side * 0.3, y0 + side * 0.5, y0 + side * 0.7];
  stub(cv, wx0, wy[0], wx1, wy[0], t * 0.9, CREAM, alphaMul);
  stub(cv, wx0, wy[1], wx1, wy[1], t * 0.9, CREAM, alphaMul);
  stub(cv, wx0, wy[2], wx1, wy[2], t * 0.9, CREAM, alphaMul);
  stub(cv, (wx0 + wx1) / 2, wy[0], (wx0 + wx1) / 2, wy[2], t * 0.9, CREAM, alphaMul);

  // 丶（点在右下角，让"国"更像印）
  circle(cv, x0 + side * 0.84, y0 + side * 0.84, side * 0.045, CREAM, alphaMul);
}

function iconPng(size, { round = false, transparentBg = false } = {}) {
  const cv = makeCanvas(size);
  if (!transparentBg) {
    if (round) circle(cv, size / 2, size / 2, size / 2 - 1, SEAL);
    else roundRect(cv, 0, 0, size, size, size * 0.18, SEAL);
  }
  drawSeal(cv, { cx: size / 2, cy: size / 2, side: size * (transparentBg ? 0.62 : 0.66), alphaMul: 1 });
  return encodePng(size, size, cv.data);
}

function foregroundPng(size) {
  // 自适应图标前景：透明底、中间印章，四周留安全区
  const cv = makeCanvas(size);
  drawSeal(cv, { cx: size / 2, cy: size / 2, side: size * 0.46 });
  return encodePng(size, size, cv.data);
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

for (const [density, size] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), iconPng(size));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), iconPng(size, { round: true }));
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), foregroundPng(Math.round(size * 1.5)));
  console.log(`✓ ${density}: ${size}px 图（含圆角/圆形/自适应前景）`);
}

// 自适应背景改成纯朱砂
const bg = path.join(RES, 'drawable', 'ic_launcher_background.xml');
fs.mkdirSync(path.dirname(bg), { recursive: true });
fs.writeFileSync(
  bg,
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#9E2B25" android:pathData="M0,0h108v108h-108z" />
</vector>
`,
  'utf8',
);
console.log('✓ 自适应图标背景改为朱砂');
