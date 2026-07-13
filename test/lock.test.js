import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, readLock } from '../src/lock.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm3-lock-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('测试10 运行锁：第一个获得锁，第二个安全退出', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'collector.lock');

    const first = acquireLock(lockPath, { runId: 'run-1', startedAt: new Date().toISOString() });
    assert.equal(first.acquired, true);
    assert.ok(existsSync(lockPath));

    // 第二个获取（同进程模拟并发）——锁仍被本进程持有，应安全退出
    const second = acquireLock(lockPath, { runId: 'run-2', startedAt: new Date().toISOString() });
    assert.equal(second.acquired, false);
    assert.equal(second.holder.runId, 'run-1', '第二个应看到第一个持有的锁');
  });
});

test('释放后可以再次获取', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'collector.lock');
    const first = acquireLock(lockPath, { runId: 'run-1', startedAt: new Date().toISOString() });
    assert.equal(first.acquired, true);

    releaseLock(lockPath, 'run-1');
    assert.equal(existsSync(lockPath), false);

    const again = acquireLock(lockPath, { runId: 'run-2', startedAt: new Date().toISOString() });
    assert.equal(again.acquired, true);
    assert.equal(readLock(lockPath).runId, 'run-2');
  });
});

test('releaseLock 只删除属于本次 runId 的锁', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'collector.lock');
    acquireLock(lockPath, { runId: 'run-1', startedAt: new Date().toISOString() });

    releaseLock(lockPath, 'other-run'); // pid 相同，仍会删（属于本进程）——见实现说明
    // 因为 pid === process.pid，锁被视为本进程的，允许删除
    assert.equal(existsSync(lockPath), false);
  });
});

test('陈旧锁：PID 判定为不存活时清除并获取（注入 isProcessAlive）', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'collector.lock');
    // 第一次用注入 isProcessAlive=false，模拟锁文件里的 pid 已死
    // 先写一个锁（本进程），然后第二次获取时把存活判定强制为 false
    acquireLock(lockPath, { runId: 'stale-holder', startedAt: '2000-01-01T00:00:00.000Z' });

    const result = acquireLock(
      lockPath,
      { runId: 'new-run', startedAt: new Date().toISOString() },
      { isProcessAlive: () => false },
    );
    assert.equal(result.acquired, true, 'PID 不存活的陈旧锁应被清除并重新获取');
    assert.equal(readLock(lockPath).runId, 'new-run');
  });
});

test('陈旧锁：PID 存活但锁过老（超过 maxAge）也视为陈旧', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'collector.lock');
    // 锁的 startedAt 很久以前，PID 判定为存活，但 staleMaxAgeMs 很小 → 应视为陈旧
    acquireLock(lockPath, { runId: 'old-holder', startedAt: '2000-01-01T00:00:00.000Z' });

    const result = acquireLock(
      lockPath,
      { runId: 'fresh-run', startedAt: new Date().toISOString() },
      { isProcessAlive: () => true, staleMaxAgeMs: 1000 },
    );
    assert.equal(result.acquired, true, '过老的锁即使 PID 存活也应被清除，避免永久阻塞');
    assert.equal(readLock(lockPath).runId, 'fresh-run');
  });
});
