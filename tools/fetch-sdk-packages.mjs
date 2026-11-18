#!/usr/bin/env node
/**
 * 手动装 Android SDK 包（绕开 sdkmanager 的 Java TLS 问题）。
 * 本机 Java/curl 拿 dl.google.com 会失败，但 Node fetch 能通，
 * 所以：读 repository2-1.xml → 找包 URL → 下 zip → 交给 PowerShell 解压。
 *
 * 用法：node tools/fetch-sdk-packages.mjs <sdkDir>
 * 输出：<sdkDir>/_dl/<zip>，并写 <sdkDir>/_dl/manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sdkDir = path.resolve(process.argv[2] ?? 'K:/dshworkspace/android-sdk');
const dlDir = path.join(sdkDir, '_dl');
fs.mkdirSync(dlDir, { recursive: true });

const REPO = 'https://dl.google.com/android/repository/repository2-1.xml';
const WANT = [
  'platform-tools',
  'platforms;android-34',
  'platforms;android-35',
  'build-tools;34.0.0',
  'build-tools;35.0.0',
];

console.log(`拉取 ${REPO}`);
const xml = await (await fetch(REPO, { signal: AbortSignal.timeout(60000) })).text();
console.log(`  仓库清单 ${(xml.length / 1024).toFixed(0)} KB`);

/** 极简解析：按 <remotePackage ...>...</remotePackage> 切块，块内定向取字段 */
function parsePackages(text) {
  const out = new Map();
  const re = /<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g;
  let m;
  while ((m = re.exec(text))) {
    const [, pkgPath, body] = m;
    const archives = [];
    const archRe = /<archive>([\s\S]*?)<\/archive>/g;
    let a;
    while ((a = archRe.exec(body))) {
      const b = a[1];
      const hostOs = b.match(/<host-os>([^<]+)<\/host-os>/)?.[1] ?? null;
      const url = b.match(/<url>([^<]+)<\/url>/)?.[1];
      const size = Number(b.match(/<size>(\d+)<\/size>/)?.[1] ?? 0);
      const checksum = b.match(/<checksum[^>]*>([^<]+)<\/checksum>/)?.[1] ?? null;
      if (url) archives.push({ hostOs, url, size, checksum });
    }
    const rev = body.match(/<revision>[\s\S]*?<\/revision>/)?.[0] ?? '';
    const major = Number(rev.match(/<major>(\d+)<\/major>/)?.[1] ?? 0);
    const minor = Number(rev.match(/<minor>(\d+)<\/minor>/)?.[1] ?? 0);
    out.set(pkgPath, { pkgPath, major, minor, archives });
  }
  return out;
}

const pkgs = parsePackages(xml);
const manifest = [];
for (const want of WANT) {
  const p = pkgs.get(want);
  if (!p) {
    console.warn(`⚠ 仓库里没有 ${want}`);
    continue;
  }
  const candidates = p.archives.filter((a) => !a.hostOs || a.hostOs === 'windows');
  const pick = candidates.find((a) => a.hostOs === 'windows') ?? candidates[0];
  if (!pick) {
    console.warn(`⚠ ${want} 没有可用于 Windows 的归档`);
    continue;
  }
  manifest.push({ pkgPath: want, major: p.major, minor: p.minor, ...pick });
}

console.log(`\n需要下载 ${manifest.length} 个包：`);
for (const it of manifest) {
  console.log(`  · ${it.pkgPath}  ${(it.size / 1048576).toFixed(1)} MB  ${it.url}`);
}

for (const it of manifest) {
  const dest = path.join(dlDir, path.basename(it.url));
  if (fs.existsSync(dest) && (!it.size || fs.statSync(dest).size === it.size)) {
    console.log(`\n↷ 已存在，跳过 ${path.basename(it.url)}`);
    continue;
  }
  console.log(`\n↓ ${it.url}`);
  const res = await fetch(`https://dl.google.com/android/repository/${it.url}`, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${it.url}`);
  const part = `${dest}.part`;
  let got = 0;
  const t0 = Date.now();
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    got += c.length;
    if (Date.now() - t0 > 1500 && got % 1048576 < 65536) {
      process.stderr.write(`\r  ${(got / 1048576).toFixed(1)}/${(it.size / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(src, fs.createWriteStream(part));
  fs.renameSync(part, dest);
  process.stderr.write(`\r  ${(got / 1048576).toFixed(1)} MB 完成\n`);
  if (it.size && got !== it.size) throw new Error(`大小不符 ${got} != ${it.size}`);
}

fs.writeFileSync(path.join(dlDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\n✓ 下载完成，清单：${path.join(dlDir, 'manifest.json')}`);
