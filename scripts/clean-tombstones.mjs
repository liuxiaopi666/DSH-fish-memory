import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../lib/store.js';
const s = new MemoryStore(path.join(os.homedir(), '.dsh', 'fish-memory')).load();
console.log('清理前墓碑:', s.tombstones.length);
s.tombstones = [];
s.save();
console.log('记忆:', s.memories.length, '| 墓碑:', s.tombstones.length);
