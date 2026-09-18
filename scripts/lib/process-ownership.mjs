// @ts-check

import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** @typedef {{source: 'proc' | 'lsof' | 'platform', target: string, code: string}} DiscoveryGap */
/** @typedef {{pids: number[], complete: boolean, gaps: DiscoveryGap[]}} DiscoveryResult */
/** @typedef {{name: string, isDirectory(): boolean}} DirectoryEntry */
/** @typedef {{error?: any, status: number | null, stdout?: string, stderr?: string}} SpawnResult */
/** @typedef {{platform: string, uid?: number, readdir(path: string): DirectoryEntry[], readlink(path: string): string, ownerUid?(path: string): number, spawn(command: string, args: string[]): SpawnResult}} DiscoveryDependencies */

/** @param {string} path @param {string} root */
function isUnder(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/** @param {Set<number>} pids @param {DiscoveryGap[]} gaps @returns {DiscoveryResult} */
function result(pids, gaps) {
  return {
    pids: [...pids].filter((pid) => Number.isInteger(pid) && pid > 1).sort((left, right) => left - right),
    complete: gaps.length === 0,
    gaps,
  };
}

/**
 * Build a discovery function around explicit OS seams. Production uses the
 * defaults below; tests provide scripted process tables so completeness and
 * permission behavior are deterministic.
 *
 * @param {DiscoveryDependencies} dependencies
 */
export function createProcessOwnershipDiscovery({ platform, uid, readdir, readlink, ownerUid, spawn }) {
  // Discovery is scoped to the current user's processes on both platforms (Darwin via `lsof -u`).
  // Another user's /proc/<pid>/cwd is unreadable by design (EACCES), so counting those as gaps would
  // make every non-root Linux scan incomplete and the reaper would never reap anything.
  const selfUid = uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  /** @param {string} rootReal @returns {DiscoveryResult} */
  return function discover(rootReal) {
    const pids = new Set();
    /** @type {DiscoveryGap[]} */
    const gaps = [];

    if (platform === 'linux') {
      /** @type {DirectoryEntry[]} */
      let entries;
      try {
        entries = readdir('/proc');
      } catch (/** @type {any} */ error) {
        gaps.push({ source: 'proc', target: '/proc', code: String(error?.code || 'UNKNOWN') });
        return result(pids, gaps);
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const target = `/proc/${entry.name}/cwd`;
        if (ownerUid) {
          let owner;
          try {
            owner = ownerUid(`/proc/${entry.name}`);
          } catch (/** @type {any} */ error) {
            if (error?.code === 'ENOENT') continue;
            gaps.push({ source: 'proc', target: `/proc/${entry.name}`, code: String(error?.code || 'UNKNOWN') });
            continue;
          }
          if (owner !== selfUid) continue;
        }
        try {
          if (isUnder(readlink(target), rootReal)) pids.add(Number(entry.name));
        } catch (/** @type {any} */ error) {
          // ENOENT is a process that exited during enumeration, not a discovery
          // gap. Permission failures and unexpected I/O errors are fail-closed.
          if (error?.code !== 'ENOENT') {
            gaps.push({ source: 'proc', target, code: String(error?.code || 'UNKNOWN') });
          }
        }
      }
      return result(pids, gaps);
    }

    if (platform === 'darwin') {
      const scan = spawn('lsof', ['-a', '-d', 'cwd', '-u', String(selfUid), '-F', 'pn']);
      if (scan.error) {
        gaps.push({ source: 'lsof', target: 'lsof', code: String(scan.error.code || 'UNKNOWN') });
        return result(pids, gaps);
      }
      if (scan.status !== 0) {
        gaps.push({ source: 'lsof', target: 'lsof', code: `EXIT_${scan.status ?? 'UNKNOWN'}` });
        return result(pids, gaps);
      }
      let pid = NaN;
      for (const line of (scan.stdout || '').split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && isUnder(line.slice(1), rootReal)) pids.add(pid);
      }
      return result(pids, gaps);
    }

    gaps.push({ source: 'platform', target: platform, code: 'UNSUPPORTED' });
    return result(pids, gaps);
  };
}

const productionDiscovery = createProcessOwnershipDiscovery({
  platform: process.platform,
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  readlink: (path) => readlinkSync(path),
  ownerUid: (path) => statSync(path).uid,
  spawn: (command, args) => spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 2_000,
  }),
});

/** @param {string} rootReal @returns {DiscoveryResult} */
export function findProcessesUnder(rootReal) {
  return productionDiscovery(rootReal);
}
