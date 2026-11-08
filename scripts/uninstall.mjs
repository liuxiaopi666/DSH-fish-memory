#!/usr/bin/env node
// 卸载：从 profile 的依赖 / bundles 里去掉本插件，并删除链接（记忆数据不删）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PACKAGE = 'dsh-fish-memory';
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
if (pkg.dependencies) delete pkg.dependencies[PACKAGE];
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PACKAGE);
}
fs.writeFileSync(pkgFile + '.bak-fish-memory-uninstall-' + Date.now(), raw, 'utf8');
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
try {
  fs.rmSync(path.join(profileDir, 'node_modules', PACKAGE), { recursive: true, force: true });
} catch {}
console.log('已卸载 ' + PACKAGE + '（记忆数据仍在 ' + path.join(home, 'fish-memory') + '）');
