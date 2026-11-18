/**
 * 网卡选择 / 子网广播 的单测。
 * 这里守护的是"家用三种接法都要能找到中枢"：
 *   ① 同一个 WiFi  ② 电脑连手机热点  ③ 手机 WiFi + 电脑网线（同路由器）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLanInterfaces, subnetBroadcast, isHotspotAddress, announceTargets } from '../net.mjs';

const iface = (address, netmask, extra = {}) => [{ family: 'IPv4', address, netmask, internal: false, ...extra }];

const mixed = {
  'WLAN 3': iface('192.168.43.106', '255.255.255.0'),
  'Ethernet': iface('192.168.1.20', '255.255.255.0'),
  'vEthernet (WSL (Hyper-V firewall))': iface('172.24.144.1', '255.255.240.0'),
  'vEthernet (Default Switch)': iface('172.28.16.1', '255.255.240.0'),
  'VirtualBox Host-Only Network': iface('192.168.56.1', '255.255.255.0'),
  'Bluetooth Network Connection': iface('169.254.10.5', '255.255.0.0'),
  'Loopback Pseudo-Interface 1': iface('127.0.0.1', '255.0.0.0', { internal: true }),
  'IPv6 only': [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff::', internal: false }],
};

test('虚拟网卡必须被过滤掉，只剩真网卡', () => {
  const list = pickLanInterfaces(mixed);
  assert.deepEqual(list.map((i) => i.name), ['WLAN 3', 'Ethernet']);
  assert.deepEqual(list.map((i) => i.address), ['192.168.43.106', '192.168.1.20']);
});

test('没有真网卡时返回空数组（主程序据此报警）', () => {
  assert.deepEqual(pickLanInterfaces({}), []);
  assert.deepEqual(pickLanInterfaces({ 'vEthernet (WSL)': iface('172.24.144.1', '255.255.240.0') }), []);
});

test('子网广播地址：/24、/20、/16 都要算对', () => {
  assert.equal(subnetBroadcast({ address: '192.168.43.106', netmask: '255.255.255.0' }), '192.168.43.255');
  assert.equal(subnetBroadcast({ address: '192.168.1.20', netmask: '255.255.255.0' }), '192.168.1.255');
  assert.equal(subnetBroadcast({ address: '172.24.144.1', netmask: '255.255.240.0' }), '172.24.159.255');
  assert.equal(subnetBroadcast({ address: '10.0.5.7', netmask: '255.255.0.0' }), '10.0.255.255');
  // 缺字段时退回全局广播，不能算出个瞎地址
  assert.equal(subnetBroadcast({}), '255.255.255.255');
  assert.equal(subnetBroadcast({ address: '192.168.1.5' }), '255.255.255.255', '缺掩码时不要猜');
});

test('广播目标 = 全局广播 + 每张网卡的子网广播（去重）', () => {
  const targets = announceTargets(mixed);
  assert.deepEqual(targets, ['255.255.255.255', '192.168.43.255', '192.168.1.255']);

  // 网线 + WiFi 同网段时不该重复发两次
  const sameSubnet = {
    'WLAN 3': iface('192.168.1.30', '255.255.255.0'),
    'Ethernet': iface('192.168.1.20', '255.255.255.0'),
  };
  assert.deepEqual(announceTargets(sameSubnet), ['255.255.255.255', '192.168.1.255']);

  // 只有虚拟网卡时也别崩：仍然返回全局广播
  assert.deepEqual(announceTargets({ 'vEthernet (WSL)': iface('172.24.144.1', '255.255.240.0') }), ['255.255.255.255']);
});

test('热点网段识别（只用于日志标注，不参与逻辑）', () => {
  assert.equal(isHotspotAddress('192.168.43.106'), true); // Android 热点
  assert.equal(isHotspotAddress('172.20.10.2'), true); // iPhone 热点
  assert.equal(isHotspotAddress('192.168.1.20'), false); // 普通家里路由器
  assert.equal(isHotspotAddress('10.0.0.5'), false);
  assert.equal(isHotspotAddress(''), false);
});
