const { createRequire: makeRequire } = await import('node:module');
export const load = makeRequire(import.meta.url);
