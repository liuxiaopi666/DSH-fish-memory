#!/usr/bin/env node
// 把插件装进 DSH profile（link 依赖 + bundles 行 + node_modules junction），全程幂等、可回滚。
//   node scripts/install.mjs [profileName]     默认 desktop
//   node scripts/uninstall.mjs [profileName]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-fish-memory';
const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileName = process.argv[2] ?? 'desktop';
const profileDir = path.join(home, 'profiles', profileName);
const pkgFile = path.join(profileDir, 'package.json');

if (!fs.existsSync(pkgFile)) {
  console.error('找不到 profile：' + pkgFile);
  process.exit(1);
}

const raw = fs.readFileSync(pkgFile, 'utf8');
const pkg = JSON.parse(raw);
const before = JSON.stringify(pkg);
const linkSpec = 'link:' + SELF.split(path.sep).join('/');

pkg.dependencies = pkg.dependencies ?? {};
pkg.dependencies[PACKAGE] = linkSpec;
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes(PACKAGE)) bundles.push(PACKAGE);
pkg.dsh.profile.bundles = bundles;

if (JSON.stringify(pkg) === before) {
  console.log('package.json 无需修改（已安装过）');
} else {
  const backup = pkgFile + '.bak-fish-memory-' + Date.now();
  fs.writeFileSync(backup, raw, 'utf8');
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('已更新 package.json（备份：' + backup + '）');
  console.log('  依赖 ' + PACKAGE + ' = ' + linkSpec);
  console.log('  bundles 追加 ' + PACKAGE);
}

// node_modules junction：link 依赖不需要网络，手工建链接即可（插件自身零依赖）
const linkPath = path.join(profileDir, 'node_modules', PACKAGE);
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
try {
  fs.rmSync(linkPath, { recursive: true, force: true });
} catch {}
fs.symlinkSync(SELF, linkPath, 'junction');
console.log('已建立链接：' + linkPath + ' -> ' + SELF);

const storeDir = path.join(home, 'fish-memory');
fs.mkdirSync(storeDir, { recursive: true });
console.log('');
console.log('安装完成。记忆库目录：' + storeDir);
console.log('接下来：重启 DSH（桌面端退出再打开），然后打开 http://127.0.0.1:<DSH端口>/fish-memory');
console.log('不想重启也能立刻看界面：node ' + path.join(SELF, 'lib', 'standalone.mjs'));
