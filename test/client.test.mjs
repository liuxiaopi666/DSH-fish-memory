// 客户端半冒烟：假 __ModuleLoader__ / require / fetch，验证装载路径与两处槽位注册
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadClient() {
  const source = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8');
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  new Function(source)();
  assert.ok(captured, '必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-fish-memory', 'id 必须等于包名');
  const react = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  return captured.factory((name) => (name === 'react' ? react : {}));
}

function fakeSlots() {
  const registered = [];
  const injected = [];
  return {
    registered,
    injected,
    slots: {
      inject: (name, run) => { injected.push(name); return run(); },
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
    },
  };
}

test('走 __ModuleLoader__ 协议，导出 apply 与 inject', () => {
  const mod = loadClient();
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.PANEL_ID, 'fish-memory');
  assert.ok(Array.isArray(mod.inject));
});

test('ctx.slots 与 ctx.get("slots") 两条路径都能注册（照 B站鱼塘 的取法）', () => {
  const mod = loadClient();

  const viaProperty = fakeSlots();
  mod.apply({ slots: viaProperty.slots });
  assert.deepEqual(viaProperty.injected.slice().sort(), ['main', 'sidebar.panellist']);

  const viaGet = fakeSlots();
  mod.apply({ get: (name) => (name === 'slots' ? viaGet.slots : undefined) });
  assert.deepEqual(viaGet.injected.slice().sort(), ['main', 'sidebar.panellist']);

  const row = viaGet.registered.find((r) => r.options.name === 'sidebar.panellist');
  assert.equal(row.options.id, mod.PANEL_ID);
  assert.equal(row.options.label, '记忆');
  assert.equal(typeof row.options.order, 'number');
  assert.equal(row.component, mod.MemoryGlyph);

  const body = viaGet.registered.find((r) => r.options.name === 'main');
  assert.equal(body.options.key, mod.PANEL_ID, 'main.key 必须等于 panellist.id');
  assert.equal(body.component, mod.MemoryPanel);
});

test('slots 还没就绪时不抛，也不崩界面', () => {
  const mod = loadClient();
  const broken = { get: () => undefined };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => mod.apply(broken));
    assert.equal(typeof mod.apply({}), 'function');
  } finally {
    console.warn = originalWarn;
  }
});

test('正文壳内嵌宿主页面，且不引外网资源', () => {
  const mod = loadClient();
  const tree = JSON.stringify(mod.MemoryPanel());
  assert.ok(tree.includes('/fish-memory/?embed=1'));
  assert.ok(!/https?:\/\//.test(tree));
  assert.ok(JSON.stringify(mod.MemoryGlyph({ size: 16, active: true })).length > 10);
});
