/**
 * Supabase 客户端 - V2
 * 用于跨平台游戏追踪
 */

import { createClient } from '@supabase/supabase-js';

let supabase = null;

/**
 * 获取 Supabase 客户端
 */
export function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_KEY 环境变量');
    }

    supabase = createClient(url, key);
  }
  return supabase;
}

/**
 * 获取所有订阅源
 */
export async function getFeeds() {
  const db = getSupabase();
  const { data, error } = await db
    .from('feeds')
    .select('url')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('获取订阅源失败:', error);
    return [];
  }

  return data.map(row => row.url);
}

/**
 * 添加订阅源
 */
export async function addFeed(url) {
  const db = getSupabase();
  const domain = new URL(url).hostname;

  const { error } = await db
    .from('feeds')
    .upsert({ url, domain, updated_at: new Date().toISOString() }, { onConflict: 'url' });

  if (error) {
    console.error('添加订阅源失败:', error);
    return false;
  }

  return true;
}

/**
 * 删除订阅源
 */
export async function removeFeed(url) {
  const db = getSupabase();

  const { error } = await db
    .from('feeds')
    .delete()
    .eq('url', url);

  if (error) {
    console.error('删除订阅源失败:', error);
    return false;
  }

  return true;
}

/**
 * 检查 URL 是否已存在于 game_sources
 */
export async function checkUrlExists(url) {
  const db = getSupabase();

  const { data, error } = await db
    .from('game_sources')
    .select('id')
    .eq('url', url)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('检查URL失败:', error);
  }

  return !!data;
}

/**
 * 获取 sitemap 内容
 */
export async function getSitemapContent(domain) {
  const db = getSupabase();

  const { data, error } = await db
    .from('sitemaps')
    .select('content')
    .eq('domain', domain)
    .single();

  if (error) {
    if (error.code !== 'PGRST116') {
      console.error('获取 sitemap 内容失败:', error);
    }
    return null;
  }

  return data?.content || null;
}

/**
 * 保存 sitemap 内容
 */
export async function saveSitemapContent(domain, content, urlCount = 0) {
  const db = getSupabase();

  const { error } = await db
    .from('sitemaps')
    .upsert({
      domain,
      content,
      url_count: urlCount,
      updated_at: new Date().toISOString()
    }, { onConflict: 'domain' });

  if (error) {
    console.error('保存 sitemap 内容失败:', error);
    return false;
  }

  return true;
}

/**
 * 通过 clean_name 查找游戏
 */
export async function findGameByCleanName(cleanName) {
  const db = getSupabase();

  const { data, error } = await db
    .from('games')
    .select('*')
    .eq('clean_name', cleanName)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('查找游戏失败:', error);
  }

  return data || null;
}

/**
 * 创建新游戏
 */
export async function createGame(name, cleanName) {
  const db = getSupabase();

  const { data, error } = await db
    .from('games')
    .insert({ name, clean_name: cleanName })
    .select()
    .single();

  if (error) {
    // 如果是唯一约束冲突（并发插入导致），重新查询
    if (error.code === '23505') {
      return await findGameByCleanName(cleanName);
    }
    console.error('创建游戏失败:', error);
    return null;
  }

  return data;
}

/**
 * 添加游戏来源（新平台）
 */
export async function addGameSource(gameId, domain, url) {
  const db = getSupabase();

  const { error } = await db
    .from('game_sources')
    .insert({ game_id: gameId, domain, url });

  if (error) {
    if (error.code === '23505') { // 唯一约束冲突
      return false;
    }
    console.error('添加游戏来源失败:', error);
    return false;
  }

  return true;
}

/**
 * 更新游戏的平台数量和分数
 */
export async function updateGameStats(gameId) {
  const db = getSupabase();

  // 计算平台数量
  const { data: sources, error: countError } = await db
    .from('game_sources')
    .select('domain')
    .eq('game_id', gameId);

  if (countError) {
    console.error('统计平台数量失败:', countError);
    return;
  }

  const uniqueDomains = new Set(sources.map(s => s.domain));
  const platformCount = uniqueDomains.size;

  // 分数公式：平台数越多分数越高
  // 1平台=1.0, 2平台=1.5, 3平台=2.0, 4+平台=2.5+
  const score = 1.0 + Math.min(platformCount - 1, 3) * 0.5;

  const { error } = await db
    .from('games')
    .update({
      platform_count: platformCount,
      score,
      updated_at: new Date().toISOString()
    })
    .eq('id', gameId);

  if (error) {
    console.error('更新游戏统计失败:', error);
  }
}

/**
 * 添加或更新游戏（核心逻辑）
 * 返回: { isNew: boolean, isCrossPlatform: boolean, game: object }
 */
export async function upsertGame(name, cleanName, domain, url) {
  // 先查找是否已有该游戏
  let game = await findGameByCleanName(cleanName);
  let isNew = false;
  let isCrossPlatform = false;

  if (!game) {
    // 新游戏
    game = await createGame(name, cleanName);
    if (!game) return null;
    isNew = true;
  } else {
    // 已有游戏，检查是否是新平台
    const db = getSupabase();
    const { data } = await db
      .from('game_sources')
      .select('id')
      .eq('game_id', game.id)
      .eq('domain', domain)
      .single();

    if (!data) {
      // 新平台！
      isCrossPlatform = true;
    }
  }

  // 添加来源
  const added = await addGameSource(game.id, domain, url);

  if (added && (isNew || isCrossPlatform)) {
    // 更新统计
    await updateGameStats(game.id);
  }

  return { isNew, isCrossPlatform, game };
}

/**
 * 记录更新日志
 */
export async function logUpdate(domain, newGames) {
  const db = getSupabase();

  const { error } = await db
    .from('update_logs')
    .insert({
      domain,
      new_games_count: newGames.length,
      new_games: newGames
    });

  if (error) {
    console.error('记录更新日志失败:', error);
  }
}

/**
 * 清理旧日志
 */
export async function cleanOldLogs(days = 30) {
  const db = getSupabase();

  const { data, error } = await db.rpc('clean_old_logs', { days_to_keep: days });

  if (error) {
    console.error('清理旧日志失败:', error);
    return 0;
  }

  return data || 0;
}

/**
 * 获取高分游戏（跨平台）
 */
export async function getTopGames(limit = 20) {
  const db = getSupabase();

  const { data, error } = await db
    .from('games')
    .select(`
      *,
      game_sources (domain, url)
    `)
    .gte('platform_count', 2)
    .order('score', { ascending: false })
    .order('first_seen', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('获取高分游戏失败:', error);
    return [];
  }

  return data || [];
}
