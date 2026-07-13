/**
 * 配置管理模块
 * 对应原 Python 项目的 core/config.py
 */

export const telegramConfig = {
  token: null, // 从环境变量获取
  targetChat: null, // 从环境变量获取
};

export const discordConfig = {
  token: null, // 从环境变量获取
  channelId: null, // 从环境变量获取
};

/**
 * 初始化配置
 * @param {Object} env - Cloudflare Workers 环境变量
 */
export function initConfig(env) {
  telegramConfig.token = env.TELEGRAM_BOT_TOKEN || "";
  telegramConfig.targetChat = env.TELEGRAM_TARGET_CHAT || "";
  discordConfig.token = env.DISCORD_TOKEN || "";
  discordConfig.channelId = env.DISCORD_CHANNEL_ID || "";

  console.log("配置初始化完成");
  console.log("Telegram Token:", telegramConfig.token ? "已设置" : "未设置");
  console.log("Telegram Target Chat:", telegramConfig.targetChat || "未设置");
  console.log("Discord Token:", discordConfig.token ? "已设置" : "未设置");
  console.log("Discord Channel ID:", discordConfig.channelId || "未设置");
}

/**
 * 验证配置是否完整
 * @returns {Object} 验证结果
 */
export function validateConfig() {
  const errors = [];

  if (!telegramConfig.token) {
    errors.push("TELEGRAM_BOT_TOKEN 未设置");
  }

  if (!telegramConfig.targetChat) {
    errors.push("TELEGRAM_TARGET_CHAT 未设置");
  }

  return {
    isValid: errors.length === 0,
    errors
  };
} 