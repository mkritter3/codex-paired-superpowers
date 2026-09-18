import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProcessOwnershipDiscovery } from '../../scripts/lib/process-ownership.mjs';

function dirent(name, directory = true) {
  return { name, isDirectory: () => directory };
}

test('discovery reports complete false with a gap on an injected proc permission error', () => {
  const findProcessesUnder = createProcessOwnershipDiscovery({
    platform: 'linux',
    readdir: () => [dirent('101'), dirent('102'), dirent('self', false)],
    readlink: (path) => {
      if (path === '/proc/101/cwd') return '/run/root/member';
      const error = Object.assign(new Error('denied'), { code: 'EACCES' });
      throw error;
    },
    spawn: () => { throw new Error('linux discovery must not spawn'); },
  });

  const result = findProcessesUnder('/run/root');
  assert.deepEqual(result.pids, [101]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.gaps, [{ source: 'proc', target: '/proc/102/cwd', code: 'EACCES' }]);
});

test('discovery reports complete false with a gap when lsof is missing', () => {
  const findProcessesUnder = createProcessOwnershipDiscovery({
    platform: 'darwin',
    readdir: () => { throw new Error('darwin discovery must not read /proc'); },
    readlink: () => { throw new Error('darwin discovery must not read links'); },
    spawn: () => ({
      error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }),
      status: null,
      stdout: '',
      stderr: '',
    }),
  });

  assert.deepEqual(findProcessesUnder('/run/root'), {
    pids: [],
    complete: false,
    gaps: [{ source: 'lsof', target: 'lsof', code: 'ENOENT' }],
  });
});

test('scripted linux and Darwin discovery return sorted unique cwd owners', () => {
  const linux = createProcessOwnershipDiscovery({
    platform: 'linux',
    readdir: () => [dirent('9'), dirent('3'), dirent('4')],
    readlink: (path) => ({
      '/proc/9/cwd': '/run/root',
      '/proc/3/cwd': '/elsewhere',
      '/proc/4/cwd': '/run/root/nested',
    })[path],
    spawn: () => { throw new Error('not used'); },
  });
  assert.deepEqual(linux('/run/root'), { pids: [4, 9], complete: true, gaps: [] });

  const darwin = createProcessOwnershipDiscovery({
    platform: 'darwin',
    readdir: () => { throw new Error('not used'); },
    readlink: () => { throw new Error('not used'); },
    spawn: () => ({
      status: 0,
      stdout: 'p12\nn/run/root/nested\np7\nn/elsewhere\np12\nn/run/root\n',
      stderr: '',
    }),
  });
  assert.deepEqual(darwin('/run/root'), { pids: [12], complete: true, gaps: [] });
});
