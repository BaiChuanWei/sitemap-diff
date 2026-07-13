import { createClient } from '@supabase/supabase-js'

// 仅供 Next.js API route（web/src/pages/api/**）在服务端调用，禁止被任何
// 客户端组件 import —— SUPABASE_SERVICE_KEY 没有 NEXT_PUBLIC_ 前缀，
// Next.js 不会把它打进浏览器 bundle，但如果被 client 组件间接 import 到，
// 打包时会直接报错（找不到该 env var）而不是静默泄露，属于预期行为。
export function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || ''

  if (!url || !serviceKey) {
    throw new Error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_KEY 环境变量')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}
