import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { runCollect } from '../src/collect-runner.js';
import { collectSite } from '../src/sitemap/collector.js';
import { DEFAULT_LIMITS } from '../src/sitemap/limits.js';
import { startTestServer, createRouter, urlsetXml } from './helpers/http-server.js';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 300, MAX_RETRIES: 0, RETRY_BASE_DELAY_MS: 1, ...overrides };
}

test('测试11 inspect 不写库：collectSite（inspect 引擎）不改动正式 seen_urls/added_urls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-inspect-'));
  const db = openDb(join(dir, 'local.db'));
  const base = { url: undefined };
  const server = await startTestServer(
    createRouter({
      '/manual.xml': () => ({ body: urlsetXml([`${base.url}/g/a`, `${base.url}/g/b`]) }),
    }),
  );
  base.url = server.url;

  try {
    // 先用 collect 建立一些正式历史
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('s', 's.com', 1)`).run();
    await runCollect(db, {
      sites: [{ site_id: 's', domain: 's.com' }],
      runId: 'run-1',
      collectSiteFn: async () => ({
        siteId: 's',
        domain: 's.com',
        status: 'success',
        complete: true,
        truncated: false,
        truncationReasons: [],
        startedAt: 't',
        finishedAt: 't',
        durationMs: 1,
        discoveredSitemaps: [],
        processedSitemaps: [{ url: 'https://s.com/sitemap.xml', status: 'success' }],
        failedSitemaps: [],
        pageUrls: ['https://s.com/g/x'],
        pageUrlCount: 1,
        sitemapCount: 1,
        warnings: [],
        errors: [],
      }),
    });

    const before = {
      seen: db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n,
    };
    assert.equal(before.seen, 1);

    // 运行 inspect 引擎（collectSite）——它根本不接收 db，也不 import 存储层
    const inspectResult = await collectSite({
      manualSitemapUrl: `${server.url}/manual.xml`,
      limits: fastLimits(),
    });
    assert.equal(inspectResult.status, 'success');
    assert.equal(inspectResult.pageUrlCount, 2);

    const after = {
      seen: db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n,
    };
    assert.deepEqual(after, before, 'inspect 前后正式 seen_urls/added_urls 数量必须不变');
  } finally {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
