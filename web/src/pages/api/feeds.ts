import type { NextApiRequest, NextApiResponse } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

// 服务端写入 feeds 表的唯一入口。配合 supabase/migrations/0001_tighten_rls_to_service_role
// 上线后，浏览器端的 anon key 将无法再直接 insert/delete feeds，必须经过这个 API route，
// 用只在服务端可见的 SUPABASE_SERVICE_KEY 写库。
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { url } = req.body || {}
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' })
    }

    let domain: string
    try {
      domain = new URL(url).hostname
    } catch {
      return res.status(400).json({ error: 'invalid URL' })
    }

    try {
      const supabaseAdmin = getSupabaseAdmin()
      const { data, error } = await supabaseAdmin
        .from('feeds')
        .insert({ url, domain })
        .select()
        .single()

      if (error) {
        return res.status(500).json({ error: error.message })
      }
      return res.status(200).json(data)
    } catch (error: any) {
      return res.status(500).json({ error: error.message })
    }
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query.id)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'id is required' })
    }

    try {
      const supabaseAdmin = getSupabaseAdmin()
      const { error } = await supabaseAdmin.from('feeds').delete().eq('id', id)

      if (error) {
        return res.status(500).json({ error: error.message })
      }
      return res.status(204).end()
    } catch (error: any) {
      return res.status(500).json({ error: error.message })
    }
  }

  res.setHeader('Allow', ['POST', 'DELETE'])
  return res.status(405).json({ error: `Method ${req.method} not allowed` })
}
