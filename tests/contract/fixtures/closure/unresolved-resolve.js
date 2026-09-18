import { createRequire as makeRequire } from 'module';
const req = makeRequire(import.meta.url);
req.resolve(path);
