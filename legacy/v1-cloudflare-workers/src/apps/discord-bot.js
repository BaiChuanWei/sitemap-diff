/**
 * Discord 机器人模块
 * 对应原 Python 项目的 apps/discord_bot.py
 * 使用 Discord Webhook 或 Bot API
 */

import { discordConfig } from '../config.js';

/**
 * 发送消息到 Discord（自动处理长消息分割）
 * @param {string} channelId - 频道 ID
 * @param {string} content - 消息内容
 * @param {Object} options - 其他选项
 * @returns {Promise<Object>} API 响应
 */
export async function sendDiscordMessage(channelId, content, options = {}) {
  try {
    const MAX_LENGTH = 1900; // Discord 限制 2000，留一些余量

    // 如果消息太长，分割发送
    if (content.length > MAX_LENGTH) {
      console.log(`消息过长 (${content.length} 字符)，分割发送...`);

      const lines = content.split('\n');
      let currentChunk = '';
      const chunks = [];

      for (const line of lines) {
        if ((currentChunk + line + '\n').length > MAX_LENGTH) {
          if (currentChunk) {
            chunks.push(currentChunk);
            currentChunk = line + '\n';
          } else {
            // 单行太长，强制截断
            chunks.push(line.substring(0, MAX_LENGTH));
          }
        } else {
          currentChunk += line + '\n';
        }
      }

      if (currentChunk) {
        chunks.push(currentChunk);
      }

      console.log(`分割成 ${chunks.length} 条消息`);

      // 发送所有分片
      let lastResponse = null;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
        lastResponse = await sendSingleMessage(channelId, prefix + chunk, options);

        // 避免发送太快
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      return lastResponse;
    } else {
      // 消息不长，直接发送
      return await sendSingleMessage(channelId, content, options);
    }
  } catch (error) {
    console.error('发送 Discord 消息失败:', error);
    throw error;
  }
}

/**
 * 发送单条消息到 Discord（内部函数）
 * @param {string} channelId - 频道 ID
 * @param {string} content - 消息内容
 * @param {Object} options - 其他选项
 * @returns {Promise<Object>} API 响应
 */
async function sendSingleMessage(channelId, content, options = {}) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const data = {
    content: content,
    ...options
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${discordConfig.token}`
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * 发送文件到 Discord
 * @param {string} channelId - 频道 ID
 * @param {string} content - 文件内容
 * @param {string} filename - 文件名
 * @param {string} message - 附加消息
 * @returns {Promise<Object>} API 响应
 */
export async function sendDiscordFile(channelId, content, filename, message = '') {
  try {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    // 创建 FormData
    const formData = new FormData();
    formData.append('file', new Blob([content], { type: 'application/xml' }), filename);
    if (message) {
      formData.append('content', message);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${discordConfig.token}`
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('发送 Discord 文件失败:', error);
    throw error;
  }
}

/**
 * 处理 Discord 交互
 * @param {Object} interaction - Discord 交互对象
 * @param {RSSManager} rssManager - RSS 管理器实例
 * @returns {Promise<Object>} 响应对象
 */
export async function handleDiscordInteraction(interaction, rssManager, env) {
  try {
    if (interaction.type === 1) { // PING
      return { type: 1 }; // PONG
    }

    if (interaction.type === 2) { // APPLICATION_COMMAND
      const command = interaction.data.name;
      const options = interaction.data.options || [];

      console.log(`收到 Discord 命令: ${command}`);

      // 处理所有命令（慢命令会在外层被拦截）
      let response = '';
      switch (command) {
        case 'rss':
          console.log('执行 RSS 命令...');
          response = await handleDiscordRSSCommand(options, rssManager);
          break;
        case 'news':
          console.log('执行 News 命令...');
          response = await handleDiscordNewsCommand(rssManager);
          break;
        case 'status':
          console.log('执行 Status 命令...');
          response = await handleDiscordStatusCommand(rssManager);
          break;
        default:
          response = '未知命令，请使用以下命令:\n/rss list - 查看监控列表\n/news - 手动触发检查\n/status - 查看状态';
      }

      // 对于慢命令，直接发送到频道而不是返回
      const slowCommands = ['rss', 'news'];
      if (slowCommands.includes(command)) {
        const channelId = discordConfig.channelId;
        if (channelId) {
          console.log('发送结果到频道:', channelId);
          await sendDiscordMessage(channelId, response);
        }
        // 返回空响应（因为已经发送到频道了）
        return { type: 4, data: { content: '✅ 结果已发送到频道' } };
      }

      return {
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: {
          content: response
        }
      };
    }

    return { success: true };
  } catch (error) {
    console.error('处理 Discord 交互失败:', error);
    return {
      type: 4,
      data: {
        content: '处理命令时发生错误，请稍后重试'
      }
    };
  }
}

/**
 * 处理 Discord RSS 命令
 * @param {Array} options - 命令选项
 * @param {RSSManager} rssManager - RSS 管理器实例
 * @returns {Promise<string>} 响应消息
 */
export async function handleDiscordRSSCommand(options, rssManager) {
  if (options.length === 0) {
    return '请使用以下命令：\n' +
      '/rss list - 显示所有监控的sitemap\n' +
      '/rss add URL - 添加sitemap监控\n' +
      '/rss del URL - 删除sitemap监控';
  }

  const subCommand = options[0].name;

  switch (subCommand) {
    case 'list':
      const feeds = await rssManager.getFeeds();
      if (feeds.length === 0) {
        return '当前没有RSS订阅';
      }

      const feedList = feeds.map(feed => `- ${feed}`).join('\n');
      return `当前RSS订阅总数${feeds.length}个,列表：\n${feedList}`;

    case 'add':
      const url = options[0].options?.[0]?.value;
      if (!url) {
        return '请提供sitemap.xml的URL';
      }

      if (!url.toLowerCase().includes('sitemap')) {
        return 'URL必须包含sitemap关键词';
      }

      const result = await rssManager.addFeed(url);
      if (result.success) {
        return `成功添加sitemap监控：${url}`;
      } else {
        return `添加sitemap监控失败：${url}\n原因：${result.errorMsg}`;
      }

    case 'del':
      const delUrl = options[0].options?.[0]?.value;
      if (!delUrl) {
        return '请提供要删除的RSS订阅链接';
      }

      const delResult = await rssManager.removeFeed(delUrl);
      if (delResult.success) {
        return `成功删除RSS订阅：${delUrl}`;
      } else {
        return `删除RSS订阅失败：${delUrl}\n原因：${delResult.errorMsg}`;
      }

    default:
      return '未知的RSS命令，请使用 /rss 查看帮助';
  }
}

/**
 * 带超时的 Promise 包装器
 * @param {Promise} promise - 要执行的 Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} timeoutError - 超时错误消息
 * @returns {Promise} 带超时的 Promise
 */
function promiseWithTimeout(promise, timeoutMs, timeoutError = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(timeoutError)), timeoutMs)
    )
  ]);
}

/**
 * 处理 Discord 新闻命令
 * @param {RSSManager} rssManager - RSS 管理器实例
 * @param {Function} progressCallback - 进度回调函数 (可选)
 * @returns {Promise<string>} 响应消息
 */
export async function handleDiscordNewsCommand(rssManager, progressCallback = null) {
  try {
    const feeds = await rssManager.getFeeds();
    if (feeds.length === 0) {
      return '当前没有监控的sitemap';
    }

    const total = feeds.length;
    const allNewUrls = [];
    let processed = 0;
    let successCount = 0;
    let errorCount = 0;
    let timeoutCount = 0;

    // 平衡并发和 CPU 限制：每批 5 个，每个最多 8 秒超时
    // 52 个 sitemap 分 11 批，预计总耗时 20-30 秒
    const BATCH_SIZE = 5;
    const TIMEOUT_MS = 8000;
    const batches = [];

    for (let i = 0; i < feeds.length; i += BATCH_SIZE) {
      batches.push(feeds.slice(i, i + BATCH_SIZE));
    }

    console.log(`开始处理 ${total} 个 sitemap，分 ${batches.length} 批，每批最多 ${BATCH_SIZE} 个`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();

      // 发送进度更新
      if (progressCallback) {
        await progressCallback(`⏳ 批次 ${batchIndex + 1}/${batches.length}\n进度: ${processed}/${total} (${Math.round(processed/total*100)}%)\n新URL: ${allNewUrls.length} 个`);
      }

      // 并发处理当前批次，每个带超时控制
      const batchResults = await Promise.allSettled(
        batch.map(async (url, idx) => {
          try {
            console.log(`[批次${batchIndex + 1}] 开始处理 #${idx + 1}: ${url.substring(0, 50)}...`);
            const result = await promiseWithTimeout(
              rssManager.addFeed(url),
              TIMEOUT_MS,
              `处理超时 (${TIMEOUT_MS}ms)`
            );
            console.log(`[批次${batchIndex + 1}] 完成 #${idx + 1}: 新URL=${result.newUrls?.length || 0}`);
            return { url, result };
          } catch (error) {
            const isTimeout = error.message.includes('超时');
            console.error(`[批次${batchIndex + 1}] 失败 #${idx + 1}: ${error.message}`);
            return {
              url,
              result: {
                success: false,
                errorMsg: error.message,
                newUrls: [],
                isTimeout
              }
            };
          }
        })
      );

      // 统计结果
      for (const item of batchResults) {
        processed++;
        if (item.status === 'fulfilled') {
          const { result } = item.value;
          if (result.success) {
            successCount++;
            if (result.newUrls && result.newUrls.length > 0) {
              allNewUrls.push(...result.newUrls);
            }
          } else {
            errorCount++;
            if (result.isTimeout) {
              timeoutCount++;
            }
          }
        } else {
          errorCount++;
          console.error('批次处理失败:', item.reason);
        }
      }

      const batchDuration = Date.now() - batchStartTime;
      console.log(`批次 ${batchIndex + 1} 完成，耗时: ${batchDuration}ms`);
    }

    // 最终进度
    if (progressCallback) {
      await progressCallback(
        `✅ 检查完成: ${processed}/${total}\n` +
        `成功: ${successCount} | 失败: ${errorCount} | 超时: ${timeoutCount}\n` +
        `新URL: ${allNewUrls.length} 个`
      );
    }

    if (allNewUrls.length === 0) {
      return `📊 检查完成\n------------------------------------\n检查了 ${total} 个sitemap\n成功: ${successCount} | 失败: ${errorCount} | 超时: ${timeoutCount}\n没有发现新的内容`;
    }

    const keywords = extractKeywords(allNewUrls);
    return `📊 关键词汇总\n` +
      `------------------------------------\n` +
      `今日新增内容: ${allNewUrls.length} 条\n` +
      `检查的sitemap: ${total} 个\n` +
      `成功: ${successCount} | 失败: ${errorCount} | 超时: ${timeoutCount}\n` +
      `主要关键词: ${keywords.join(', ')}\n` +
      `------------------------------------\n` +
      `时间: ${new Date().toLocaleString('zh-CN')}`;

  } catch (error) {
    console.error('处理 Discord 新闻命令失败:', error);
    return '处理新闻命令失败，请稍后重试';
  }
}

/**
 * 处理 Discord 状态命令
 * @param {RSSManager} rssManager - RSS 管理器实例
 * @returns {Promise<string>} 响应消息
 */
export async function handleDiscordStatusCommand(rssManager) {
  try {
    const feeds = await rssManager.getFeeds();

    const statusMessage =
      `🤖 **Site Monitor Bot 运行状态**\n` +
      `------------------------------------\n` +
      `📊 监控站点数: ${feeds.length} 个\n` +
      `⏰ 定时检查: 每8小时 (0点、8点、16点)\n` +
      `📱 推送平台: Telegram + Discord\n` +
      `✅ 状态: 正常运行\n` +
      `------------------------------------\n` +
      `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

    return statusMessage;
  } catch (error) {
    console.error('处理 Discord 状态命令失败:', error);
    return '获取状态失败，请稍后重试';
  }
}

/**
 * 提取关键词（简化版本）
 * @param {string[]} urls - URL 列表
 * @returns {string[]} 关键词列表
 */
function extractKeywords(urls) {
  const keywords = new Set();

  for (const url of urls) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      // 简单的关键词提取逻辑
      const segments = path.split('/').filter(segment => segment.length > 2);
      for (const segment of segments) {
        if (segment.length > 3 && !segment.includes('-')) {
          keywords.add(segment);
        }
      }
    } catch (error) {
      // 忽略无效 URL
    }
  }

  return Array.from(keywords).slice(0, 10); // 最多返回10个关键词
}

/**
 * 异步处理 Discord 命令（用于延迟响应）
 * @param {Object} interaction - Discord 交互对象
 * @param {RSSManager} rssManager - RSS 管理器实例
 * @param {Object} env - 环境变量
 * @returns {Promise<void>}
 */
export async function handleDiscordCommandAsync(interaction, rssManager, env) {
  try {
    const command = interaction.data.name;
    const options = interaction.data.options || [];
    const token = interaction.token;
    const applicationId = env.DISCORD_APP_ID;

    console.log(`🔄 异步处理 Discord 命令: ${command}`);
    console.log(`   Token: ${token.substring(0, 10)}...`);
    console.log(`   App ID: ${applicationId}`);

    let response = '';

    try {
      switch (command) {
        case 'rss':
          console.log('   执行 RSS 命令...');
          response = await handleDiscordRSSCommand(options, rssManager);
          break;

        case 'news':
          console.log('   执行 News 命令...');
          response = await handleDiscordNewsCommand(rssManager);
          break;

        case 'status':
          console.log('   执行 Status 命令...');
          response = await handleDiscordStatusCommand(rssManager);
          break;

        default:
          response = '未知命令';
      }

      console.log(`   ✅ 命令执行完成，响应长度: ${response.length}`);
    } catch (cmdError) {
      console.error('   ❌ 命令执行失败:', cmdError);
      response = `命令执行失败: ${cmdError.message}`;
    }

    // 编辑延迟响应消息（使用 PATCH 更新 @original 消息）
    const editUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;

    console.log(`   📤 发送 followup 到: ${editUrl}`);

    const editResponse = await fetch(editUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: response
      })
    });

    console.log(`   📨 Followup 响应状态: ${editResponse.status}`);

    if (!editResponse.ok) {
      const errorText = await editResponse.text();
      console.error(`   ❌ 编辑 Discord 延迟响应失败: ${editResponse.status}`, errorText);

      // 尝试发送新的 followup 消息作为备用
      console.log('   🔄 尝试发送新 followup 消息...');
      const followupUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;
      const followupResponse = await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: response
        })
      });

      if (followupResponse.ok) {
        console.log('   ✅ Followup 消息发送成功（备用方法）');
      } else {
        const followupError = await followupResponse.text();
        console.error('   ❌ Followup 消息也失败:', followupResponse.status, followupError);
      }
    } else {
      console.log('   ✅ Discord 命令处理完成并更新消息');
    }

  } catch (error) {
    console.error('❌ 异步处理 Discord 命令失败:', error);
    console.error('   错误详情:', error.stack);
  }
}

/**
 * 发送统一汇总报告到 Discord
 * @param {Map} domainResults - 按域名分组的结果
 * @param {number} totalNew - 总新增数量
 * @param {number} processed - 处理数量
 * @param {number} errors - 错误数量
 * @param {string} channelId - 目标频道 ID
 * @param {string} note - 附加说明
 * @returns {Promise<void>}
 */
export async function sendDiscordUnifiedReport(domainResults, totalNew, processed, errors, channelId = null, note = '') {
  try {
    const targetChannel = channelId || discordConfig.channelId;
    if (!targetChannel) {
      console.warn('未配置 Discord Channel ID，跳过 Discord 通知');
      return;
    }

    console.log('📊 开始发送 Discord 统一汇总报告...');

    // 构建报告内容
    let description = `本次共检查 **${processed}** 个站点`;

    if (totalNew > 0) {
      description += `，发现 **${totalNew}** 个新 URL`;
    } else {
      description += `，暂无新内容`;
    }

    if (errors > 0) {
      description += `\n⚠️ ${errors} 个站点检查失败`;
    }

    if (note) {
      description += note;
    }

    // 构建域名更新字段
    const fields = [];
    let index = 0;
    for (const [domain, data] of domainResults) {
      if (data.totalNew > 0 && index < 10) { // 最多显示10个域名
        fields.push({
          name: `📌 ${domain}`,
          value: `新增: ${data.totalNew} 个 URL`,
          inline: true
        });
        index++;
      }
    }

    if (domainResults.size > 10) {
      fields.push({
        name: '...',
        value: `还有 ${domainResults.size - 10} 个域名有更新`,
        inline: false
      });
    }

    if (fields.length === 0 && totalNew === 0) {
      fields.push({
        name: '✅ 状态',
        value: '所有站点都没有新内容更新',
        inline: false
      });
    }

    // 构建 Embed 消息
    const embed = {
      title: '📊 网站监控 - 8小时汇总报告',
      description: description,
      color: totalNew > 0 ? 0x00FF00 : 0x808080, // 有更新绿色，无更新灰色
      fields: fields,
      footer: {
        text: 'Site Monitor Bot - 每8小时自动监控'
      },
      timestamp: new Date().toISOString()
    };

    // 发送 Embed 消息
    const url = `https://discord.com/api/v10/channels/${targetChannel}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${discordConfig.token}`
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    console.log('✅ Discord 统一汇总报告发送成功');

  } catch (error) {
    console.error('❌ 发送 Discord 统一汇总报告失败:', error);
  }
} 