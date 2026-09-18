import { createRequire as makeRequire } from 'node:module';
export const load = makeRequire(import.meta.url);
