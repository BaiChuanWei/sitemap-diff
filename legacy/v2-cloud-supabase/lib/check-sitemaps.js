/**
 * Sitemap 检查脚本 - V2
 * 用于 GitHub Actions 定时执行
 */

import { RSSManager } from './rss-manager.js';
import { cleanOldLogs } from './supabase.js';

/**
 * 主函数：检查所有 sitemap
 */
async function main() {
  console.log('========== 开始检查 Sitemap ==========');
  const startTime = Date.now();

  const rssManager = new RSSManager();

  try {
    const feeds = await rssManager.getFeeds();
    console.log(`总共 ${feeds.length} 个订阅源`);

    if (feeds.length === 0) {
      console.log('没有配置的订阅源');
      return;
    }

    // 统计数据
    const stats = {
      processed: 0,
      errors: 0,
      totalNewGames: 0,
      totalCrossPlatform: 0,
      byDomain: new Map()
    };

    // 处理所有 feed
    for (let i = 0; i < feeds.length; i++) {
      const url = feeds[i];
      const domain = new URL(url).hostname;

      try {
        console.log(`[${i + 1}/${feeds.length}] 检查: ${domain}`);

        const result = await rssManager.downloadSitemap(url);
        stats.processed++;

        if (result.success) {
          if (!stats.byDomain.has(domain)) {
            stats.byDomain.set(domain, { newGames: [], crossPlatform: [] });
          }

          const domainData = stats.byDomain.get(domain);

          if (result.newGames && result.newGames.length > 0) {
            domainData.newGames.push(...result.newGames);
            stats.totalNewGames += result.newGames.length;
          }

          if (result.crossPlatformGames && result.crossPlatformGames.length > 0) {
            domainData.crossPlatform.push(...result.crossPlatformGames);
            stats.totalCrossPlatform += result.crossPlatformGames.length;
          }
        } else {
          stats.errors++;
          console.warn(`  失败: ${result.errorMsg}`);
        }

      } catch (error) {
        stats.errors++;
        console.error(`  错误: ${error.message}`);
      }

      // 请求间隔
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n========== 检查完成 ==========');
    console.log(`处理: ${stats.processed}/${feeds.length}`);
    console.log(`失败: ${stats.errors}`);
    console.log(`新游戏: ${stats.totalNewGames}`);
    console.log(`跨平台游戏: ${stats.totalCrossPlatform}`);
    console.log(`耗时: ${duration}s`);

    // 显示每个域名的详情
    if (stats.byDomain.size > 0) {
      console.log('\n域名详情:');
      for (const [domain, data] of stats.byDomain) {
        const total = data.newGames.length + data.crossPlatform.length;
        if (total > 0) {
          console.log(`  ${domain}: ${data.newGames.length} 新游戏, ${data.crossPlatform.length} 跨平台`);
        }
      }
    }

    // 清理旧日志
    const cleaned = await cleanOldLogs(30);
    if (cleaned > 0) {
      console.log(`\n清理了 ${cleaned} 条旧日志`);
    }

  } catch (error) {
    console.error('检查失败:', error);
    process.exit(1);
  }
}

// 执行
main().catch(error => {
  console.error('执行失败:', error);
  process.exit(1);
});
