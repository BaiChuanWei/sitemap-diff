import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 本地进程运行锁，防止 Windows 任务计划程序重叠执行同一个采集任务。
 *
 * 锁文件（默认 data/collector.lock）内容：{ pid, runId, startedAt }。
 *
 * 设计要点：
 *   - 用 'wx'（O_EXCL）独占创建，天然避免"检查存在再写入"之间的竞态；
 *   - 已存在且仍然有效的锁 → 本轮安全退出，不写库；
 *   - 陈旧锁必须同时验证 PID 与启动时间后才能清除，避免误判：
 *       · PID 已不存在 → 陈旧，可清除；
 *       · PID 存在但锁的 startedAt 过老（超过最大存活时长）→ 视为陈旧/PID 复用，可清除；
 *   - 不因为陈旧锁永久阻塞运行。
 */
const STALE_LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 小时

export function acquireLock(lockPath, { runId, startedAt }, options = {}) {
  const maxAgeMs = options.staleMaxAgeMs ?? STALE_LOCK_MAX_AGE_MS;
  const isAlive = options.isProcessAlive || defaultIsProcessAlive;
  mkdirSync(dirname(lockPath), { recursive: true });

  const payload = JSON.stringify({ pid: process.pid, runId, startedAt });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return { acquired: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const holder = readLock(lockPath);
      if (holder && isLockHeld(holder, { maxAgeMs, isAlive })) {
        return { acquired: false, holder };
      }
      // 陈旧锁：清除后重试一次
      rmSync(lockPath, { force: true });
    }
  }

  // 兜底：两次都没拿到（极少见的并发竞争）
  return { acquired: false, holder: readLock(lockPath) };
}

/** 释放锁。传入 runId 时只删除属于本次运行的锁，避免误删别人的锁。 */
export function releaseLock(lockPath, runId) {
  const holder = readLock(lockPath);
  if (!holder) return;
  if (runId === undefined || holder.runId === runId || holder.pid === process.pid) {
    rmSync(lockPath, { force: true });
  }
}

export function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function isLockHeld(holder, { maxAgeMs, isAlive }) {
  if (!holder || !holder.pid) return false;
  if (!isAlive(holder.pid)) return false;
  const age = Date.now() - new Date(holder.startedAt).getTime();
  if (Number.isFinite(age) && age > maxAgeMs) return false; // 过老 → 视为陈旧/PID 复用
  return true;
}

function defaultIsProcessAlive(pid) {
  try {
    // signal 0 不发送信号，只做存在性/权限检查
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: 进程不存在；EPERM: 存在但无权限（仍然算存活）
    return err.code === 'EPERM';
  }
}
