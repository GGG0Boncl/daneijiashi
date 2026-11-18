#!/usr/bin/env node
/**
 * 统一 App 身份：改显示名（大内家事）+ 体检图标（尺寸/颜色占比）。
 * 用法：node tools/app-identity.mjs [--check-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check-only');
const NAME = '大内家事';

if (!checkOnly) {
  const cfgPath = path.join(ROOT, 'app', 'capacitor.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.appName = NAME;
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  console.log(`✓ capacitor.config.json appName = ${NAME}`);

  const stringsPath = path.join(ROOT, 'app', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  let xml = fs.readFileSync(stringsPath, 'utf8');
  xml = xml.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${NAME}$2`);
  xml = xml.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${NAME}$2`);
  fs.writeFileSync(stringsPath, xml, 'utf8');
  console.log('✓ strings.xml 已更新');
  console.log(xml.trim());
}

/* ------------------------- 读回 PNG 体检 ------------------------- */

function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} 不是 PNG`);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { width, height, raw };
}

const isCream = (r, g, b, a) => a > 100 && r > 190 && g > 160;
const isSeal = (r, g, b, a) => a > 100 && r > 110 && g < 110 && b < 110;

console.log('\n图标体检：');
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
for (const d of densities) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    const file = path.join(ROOT, 'app', 'android', 'app', 'src', 'main', 'res', `mipmap-${d}`, name);
    if (!fs.existsSync(file)) {
      console.log(`  ✗ 缺 ${d}/${name}`);
      continue;
    }
    const { width, height, raw } = readPng(file);
    let opaque = 0;
    const total = width * height;
    for (let y = 0; y < height; y += 1) {
      const row = y * (width * 4 + 1) + 1;
      for (let x = 0; x < width; x += 1) {
        const i = row + x * 4;
        if (raw[i + 3] >= 30) opaque += 1;
      }
    }
    const pct = Math.round((opaque / total) * 100);
    // 方形/前景要几乎铺满；圆形图标只有 78% 左右
    const need = name.includes('round') ? 60 : 90;
    console.log(`  ${pct >= need ? '✓' : '✗'} ${d}/${name} ${width}x${height} 不透明 ${pct}%（需 ≥${need}%）`);
  }
}
