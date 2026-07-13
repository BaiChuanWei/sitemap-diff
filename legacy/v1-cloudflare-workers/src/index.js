/**
 * Cloudflare Workers 主入口文件
 * 对应原 Python 项目的 site-bot.py
 */

import { initConfig, validateConfig } from './config.js';
import { RSSManager } from './services/rss-manager.js';
import {
  sendUpdateNotification,
  sendKeywordsSummary,
  sendUnifiedReport,
  handleTelegramUpdate
} from './apps/telegram-bot.js';
import { handleDiscordInteraction, sendDiscordUnifiedReport, handleDiscordCommandAsync } from './apps/discord-bot.js';
import { verifyDiscordSignature } from './services/discord-verify.js';

// 全局变量
let rssManager = null;

/**
 * 初始化应用
 * @param {Object} env - 环境变量
 */
function initializeApp(env) {
  console.log('🚀 初始化 Site Bot...');

  // 初始化配置
  initConfig(env);

  // 验证配置
  const validation = validateConfig();
  if (!validation.isValid) {
    console.error('❌ 配置验证失败:', validation.errors);
    throw new Error(`配置错误: ${validation.errors.join(', ')}`);
  }

  // 初始化 RSS 管理器
  if (env.SITEMAP_STORAGE) {
    rssManager = new RSSManager(env.SITEMAP_STORAGE);
    console.log('✅ RSS 管理器初始化成功');
  } else {
    console.warn('⚠️ 未配置 KV 存储，某些功能可能不可用');
  }

  console.log('✅ Site Bot 初始化完成');
}

/**
 * 执行定时监控任务（8小时统一检查版本）
 * @param {Object} env - 环境变量
 */
async function performScheduledMonitoring(env) {
  try {
    console.log('⏰ 开始执行8小时统一监控任务...');

    if (!rssManager) {
      console.error('❌ RSS 管理器未初始化');
      return;
    }

    const allFeeds = await rssManager.getFeeds();
    console.log(`📊 总共 ${allFeeds.length} 个订阅源`);

    if (allFeeds.length === 0) {
      console.log('📭 没有配置的订阅源');
      return;
    }

    // 限制每次最多处理 15 个，避免 CPU 超限
    const MAX_FEEDS_PER_RUN = 15;
    const feeds = allFeeds.slice(0, MAX_FEEDS_PER_RUN);
    const skipped = allFeeds.length - feeds.length;

    if (skipped > 0) {
      console.log(`⚠️ 由于 CPU 限制，本次只处理前 ${feeds.length} 个订阅源，跳过 ${skipped} 个`);
    }

    // 用于存储所有结果
    const domainResults = new Map(); // 按域名分组的结果
    const allNewUrls = [];
    let processedCount = 0;
    let errorCount = 0;

    console.log('🔍 开始检查sitemap（串行处理避免 CPU 超限）...');

    // 完全串行处理，最小化 CPU 消耗
    for (let i = 0; i < feeds.length; i++) {
      const url = feeds[i];
      try {
        console.log(`🔍 [${i + 1}/${feeds.length}]: ${url.substring(0, 60)}...`);

        const result = await rssManager.addFeed(url);
        processedCount++;

        if (result.success) {
          const domain = new URL(url).hostname;

          // 按域名分组统计
          if (!domainResults.has(domain)) {
            domainResults.set(domain, {
              domain: domain,
              newUrls: [],
              totalNew: 0
            });
          }

          if (result.newUrls && result.newUrls.length > 0) {
            const domainData = domainResults.get(domain);
            domainData.newUrls.push(...result.newUrls);
            domainData.totalNew += result.newUrls.length;
            allNewUrls.push(...result.newUrls);

            console.log(`✨ ${domain}: +${result.newUrls.length} 个新URL`);
          }
        } else {
          errorCount++;
          console.warn(`⚠️ ${url}: ${result.errorMsg}`);
        }

      } catch (error) {
        errorCount++;
        console.error(`❌ ${url}: ${error.message}`);
      }
    }

    console.log(`📊 检查完成: 处理 ${processedCount}/${allFeeds.length} 个，失败 ${errorCount} 个，总计新增 ${allNewUrls.length} 个URL`);

    // 发送统一汇总报告到 Telegram
    await sendUnifiedReport(domainResults, allNewUrls, processedCount, errorCount);

    // 同时发送到 Discord (如果配置了)
    // 添加限制说明
    const note = skipped > 0 ? `\n⚠️ 注意：由于 CPU 限制，本次只检查了 ${processedCount}/${allFeeds.length} 个站点` : '';
    await sendDiscordUnifiedReport(domainResults, allNewUrls.length, processedCount, errorCount, null, note);

    console.log('✅ 8小时统一监控任务完成');

  } catch (error) {
    console.error('❌ 定时监控任务失败:', error);
  }
}

/**
 * 处理 HTTP 请求
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - 上下文对象
 * @returns {Response} 响应对象
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // 健康检查
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'site-bot',
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 手动触发监控
    if (path === '/monitor' && request.method === 'POST') {
      ctx.waitUntil(performScheduledMonitoring(env));
      return new Response(JSON.stringify({
        status: 'success',
        message: '监控任务已启动',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Telegram Webhook
    if (path === '/webhook/telegram' && request.method === 'POST') {
      const update = await request.json();
      // 重要：避免长耗时处理阻塞 Webhook 响应，导致 Telegram 重试
      // 将实际处理放入后台任务，立即返回 200 给 Telegram
      try {
        ctx.waitUntil(handleTelegramUpdate(update, rssManager));
      } catch (e) {
        // 即便后台任务提交失败，也不要抛错给 Telegram，避免重试风暴
        console.error('提交 Telegram 处理任务失败:', e);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Discord Webhook
    if (path === '/webhook/discord' && request.method === 'POST') {
      try {
        // 获取请求体和签名信息
        const signature = request.headers.get('X-Signature-Ed25519');
        const timestamp = request.headers.get('X-Signature-Timestamp');
        const body = await request.text();

        // 验证 Discord 签名
        if (signature && timestamp && env.DISCORD_PUBLIC_KEY) {
          const isValid = await verifyDiscordSignature(
            body,
            signature,
            timestamp,
            env.DISCORD_PUBLIC_KEY
          );

          if (!isValid) {
            console.error('Discord 签名验证失败');
            return new Response('Invalid signature', { status: 401 });
          }

          console.log('Discord 签名验证通过');
        } else if (signature && timestamp) {
          console.warn('缺少 DISCORD_PUBLIC_KEY，跳过签名验证（不推荐）');
        }

        const interaction = JSON.parse(body);

        // 处理 PING (Discord 验证请求)
        if (interaction.type === 1) {
          console.log('收到 Discord PING 验证请求');
          return new Response(JSON.stringify({ type: 1 }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 处理所有交互
        const command = interaction.data?.name;
        const slowCommands = ['rss', 'news'];

        if (interaction.type === 2 && slowCommands.includes(command)) {
          // 慢命令：立即返回，后台处理
          console.log(`🔄 慢命令 ${command} - 启动后台任务`);

          ctx.waitUntil(
            (async () => {
              const startTime = Date.now();
              let sendMessage = null;
              let channelId = null;

              try {
                // 先导入所需的函数
                const discordBotModule = await import('./apps/discord-bot.js');
                const configModule = await import('./config.js');

                sendMessage = discordBotModule.sendDiscordMessage;
                channelId = configModule.discordConfig.channelId;

                if (!channelId) {
                  throw new Error('Discord Channel ID 未配置');
                }

                // 发送开始处理的通知
                await sendMessage(channelId, `🔄 开始处理 \`${command}\` 命令...`);

                const options = interaction.data.options || [];
                let response = '';

                if (command === 'rss') {
                  const subCommand = options[0]?.name || 'list';
                  await sendMessage(channelId, `📋 执行 RSS ${subCommand} 操作...`);
                  response = await discordBotModule.handleDiscordRSSCommand(options, rssManager);
                } else if (command === 'news') {
                  await sendMessage(channelId, `📰 检查所有 sitemap...`);
                  // 创建进度回调函数
                  const progressCallback = async (progressMsg) => {
                    await sendMessage(channelId, progressMsg);
                  };
                  response = await discordBotModule.handleDiscordNewsCommand(rssManager, progressCallback);
                }

                const duration = Date.now() - startTime;

                // 发送实际结果
                if (response) {
                  await sendMessage(channelId, response);
                  await sendMessage(channelId, `✅ 处理完成 (耗时 ${duration}ms)`);
                } else {
                  await sendMessage(channelId, `⚠️ 命令返回了空结果`);
                }

              } catch (error) {
                // 发送错误信息到频道
                const errorMsg = `❌ 后台任务失败\n` +
                  `命令: ${command}\n` +
                  `错误: ${error.message}\n` +
                  `堆栈: ${error.stack?.substring(0, 500) || '无'}`;

                try {
                  if (sendMessage && channelId) {
                    await sendMessage(channelId, errorMsg);
                  }
                } catch (sendError) {
                  // 如果连发送错误消息都失败了，只能记录到控制台
                  console.error('发送错误消息失败:', sendError);
                }

                console.error('❌ 后台命令处理失败:', error);
              }
            })()
          );

          return new Response(JSON.stringify({
            type: 4,
            data: { content: '⏳ 正在处理中，请稍候...' }
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 其他命令正常处理
        const result = await handleDiscordInteraction(interaction, rssManager, env);

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('处理 Discord webhook 失败:', error);
        return new Response(JSON.stringify({
          type: 4,
          data: { content: '处理请求失败' }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API 状态
    if (path === '/api/status') {
      const feeds = rssManager ? await rssManager.getFeeds() : [];
      return new Response(JSON.stringify({
        status: 'running',
        feeds: feeds,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 测试 Discord 推送
    if (path === '/test/discord' && request.method === 'POST') {
      try {
        const mockDomainResults = new Map([
          ['example.com', { totalNew: 3, newUrls: [] }],
          ['test.com', { totalNew: 5, newUrls: [] }]
        ]);

        await sendDiscordUnifiedReport(mockDomainResults, 8, 2, 0);

        return new Response(JSON.stringify({
          status: 'success',
          message: 'Discord 测试消息已发送',
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString()
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 测试后台任务
    if (path === '/test/background' && request.method === 'POST') {
      console.log('📝 测试后台任务...');

      ctx.waitUntil(
        (async () => {
          try {
            console.log('⏰ 后台任务开始执行...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            const feeds = await rssManager.getFeeds();
            console.log(`📊 读取到 ${feeds.length} 个订阅源`);

            // 尝试发送消息到频道
            const { sendDiscordMessage } = await import('./apps/discord-bot.js');
            const { discordConfig } = await import('./config.js');

            if (discordConfig.channelId) {
              const message = `🧪 后台任务测试\n订阅源数量: ${feeds.length}`;
              console.log('📤 发送测试消息到频道...');
              await sendDiscordMessage(discordConfig.channelId, message);
              console.log('✅ 测试消息发送成功');
            }
          } catch (error) {
            console.error('❌ 后台任务失败:', error);
          }
        })()
      );

      return new Response(JSON.stringify({
        status: 'success',
        message: '后台任务已启动，请查看频道'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 注册 Discord Slash Commands
    if (path === '/setup/discord' && request.method === 'POST') {
      try {
        const discordToken = env.DISCORD_TOKEN;
        const discordAppId = env.DISCORD_APP_ID;

        if (!discordToken || !discordAppId) {
          throw new Error('缺少 DISCORD_TOKEN 或 DISCORD_APP_ID 环境变量');
        }

        // 定义命令
        const commands = [
          {
            name: 'rss',
            description: 'RSS/Sitemap 监控管理',
            options: [
              {
                name: 'list',
                description: '显示所有监控的 sitemap',
                type: 1, // SUB_COMMAND
              },
              {
                name: 'add',
                description: '添加新的 sitemap 监控',
                type: 1, // SUB_COMMAND
                options: [
                  {
                    name: 'url',
                    description: 'Sitemap 的 URL',
                    type: 3, // STRING
                    required: true
                  }
                ]
              },
              {
                name: 'del',
                description: '删除 sitemap 监控',
                type: 1, // SUB_COMMAND
                options: [
                  {
                    name: 'url',
                    description: '要删除的 Sitemap URL',
                    type: 3, // STRING
                    required: true
                  }
                ]
              }
            ]
          },
          {
            name: 'news',
            description: '手动触发检查所有 sitemap 并推送更新'
          },
          {
            name: 'status',
            description: '查看 Bot 运行状态和统计信息'
          }
        ];

        // 注册命令
        const url = `https://discord.com/api/v10/applications/${discordAppId}/commands`;
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bot ${discordToken}`
          },
          body: JSON.stringify(commands)
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Discord API 错误: ${response.status} ${error}`);
        }

        const data = await response.json();

        return new Response(JSON.stringify({
          status: 'success',
          message: `成功注册 ${data.length} 个 Discord 命令`,
          commands: data.map(cmd => ({
            name: cmd.name,
            id: cmd.id
          })),
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('注册 Discord 命令失败:', error);
        return new Response(JSON.stringify({
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString()
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 默认响应
    return new Response(JSON.stringify({
      message: 'Site Bot API',
      endpoints: [
        '/health - 健康检查',
        '/monitor - 手动触发监控 (POST)',
        '/webhook/telegram - Telegram Webhook',
        '/webhook/discord - Discord Webhook',
        '/api/status - API 状态'
      ],
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('处理请求失败:', error);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cloudflare Workers 事件处理器
export default {
  // 处理 HTTP 请求
  async fetch(request, env, ctx) {
    // 确保应用已初始化
    if (!rssManager) {
      try {
        initializeApp(env);
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Initialization Failed',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return await handleRequest(request, env, ctx);
  },

  // 定时任务触发器
  async scheduled(event, env, ctx) {
    console.log('⏰ 收到定时任务触发');

    // 确保应用已初始化
    if (!rssManager) {
      try {
        initializeApp(env);
      } catch (error) {
        console.error('❌ 初始化失败:', error);
        return;
      }
    }

    // 执行监控任务
    ctx.waitUntil(performScheduledMonitoring(env));
  }
}; 