/**
 * 网络小工具（纯函数，便于单测）
 *
 * 家用局域网的三种常见接法都要能同步：
 *   ① 手机和电脑连同一个 WiFi
 *   ② 电脑连手机开的热点（Windows 常把这个网判成"公用"，防火墙默认拦入站）
 *   ③ 手机连 WiFi、电脑插网线（同一个路由器，通常同一网段）
 *
 * 要点：
 *   · 虚拟网卡（WSL / Hyper-V / VMware / 蓝牙…）也报 IPv4，但手机连不上，不能拿来当地址。
 *   · 多网卡（网线 + WiFi 同时连）时，要按各自子网广播地址分别喊，否则另一头收不到。
 */
import os from 'node:os';

const VIRTUAL_IFACE = /(vEthernet|WSL|Hyper-?V|Loopback|VMware|VirtualBox|Bluetooth|Teredo|isatap|Tailscale|ZeroTier|Docker|Npcap)/i;

/** 列出真正能被手机访问到的 IPv4 网卡 */
export function pickLanInterfaces(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ name, address: ni.address, netmask: ni.netmask });
    }
  }
  return out;
}

/** 由 IP + 掩码算出子网广播地址（如 192.168.43.106/24 → 192.168.43.255）；缺掩码时退回全局广播 */
export function subnetBroadcast({ address, netmask } = {}) {
  const parts = (s) => String(s ?? '').split('.').map((n) => Number(n) || 0);
  const ip = parts(address);
  const mask = parts(netmask);
  if (ip.length !== 4 || !netmask || mask.length !== 4) return '255.255.255.255';
  return ip.map((b, i) => ((b & mask[i]) | (~mask[i] & 255)) >>> 0).join('.');
}

/** 常见手机热点网段（Android 192.168.43.x / iPhone 172.20.10.x），只用于在日志里标注 */
export function isHotspotAddress(address = '') {
  return /^(192\.168\.43\.|172\.20\.10\.)/.test(String(address));
}

/**
 * 广播目标列表：全局广播 + 每张真实网卡的子网广播（去重）。
 * 多网卡时只发全局广播，可能从默认路由那张网卡出去，另一张网卡上的手机就收不到。
 */
export function announceTargets(interfaces, fallback = '255.255.255.255') {
  const targets = new Set([fallback]);
  for (const iface of pickLanInterfaces(interfaces)) targets.add(subnetBroadcast(iface));
  return [...targets];
}
