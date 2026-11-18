#!/usr/bin/env node
/**
 * 下载器：绕开 Windows schannel（curl/PowerShell 在本机会 TLS 报错），
 * 用 Node fetch 流式下载，带进度、断点续传（续传靠 Range + .part 文件）。
 *
 * 用法：node tools/fetch.mjs <url> <输出文件>
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node tools/fetch.mjs <url> <输出文件>');
  process.exit(1);
}

const abs = path.resolve(out);
fs.mkdirSync(path.dirname(abs), { recursive: true });
const part = `${abs}.part`;
const have = fs.existsSync(part) ? fs.statSync(part).size : 0;

const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
const res = await fetch(url, { headers, redirect: 'follow' });
if (!res.ok && res.status !== 206) {
  console.error(`✗ HTTP ${res.status} ${res.statusText} — ${url}`);
  process.exit(1);
}
// 注意：服务器若返回 Content-Encoding（gzip/br），fetch 会自动解压，
// 此时 content-length 是压缩后的大小，不能拿来校验，只能看流是否正常结束。
const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity';
const total = encoded ? 0 : have + Number(res.headers.get('content-length') ?? 0);
const t0 = Date.now();
let got = have;
let lastLog = 0;

const src = Readable.fromWeb(res.body);
src.on('data', (chunk) => {
  got += chunk.length;
  const now = Date.now();
  if (now - lastLog > 1500) {
    lastLog = now;
    const mb = (got / 1048576).toFixed(1);
    const tm = total ? (total / 1048576).toFixed(1) : '?';
    const speed = (got - have) / 1048576 / ((now - t0) / 1000);
    process.stderr.write(`\r  下载 ${mb}/${tm} MB  ${speed.toFixed(1)} MB/s`);
  }
});

await pipeline(src, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }));
process.stderr.write('\n');
if (total && got !== total) {
  console.error(`✗ 大小不符：期望 ${total}，实际 ${got}（保留 .part 可重试续传）`);
  process.exit(1);
}
fs.renameSync(part, abs);
console.log(`✓ 已下载 ${abs}（${(got / 1048576).toFixed(1)} MB，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
