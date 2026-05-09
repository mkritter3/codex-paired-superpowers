#!/usr/bin/env node
// Clears the backing JSON store back to its initial empty state.
// Used as the reset_command in .codex-paired/project.json so Phase E
// starts every scenario from a clean slate.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'store.json');
const INITIAL_STORE = { saves: [], displayName: '' };

fs.writeFileSync(STORE_PATH, JSON.stringify(INITIAL_STORE, null, 2), 'utf8');
console.log('store reset:', STORE_PATH);
