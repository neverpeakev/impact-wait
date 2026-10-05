export type GoodwaitAd = {
  provider: string
  label: string
  brand: string
  headline: string
  body: string
  cta: string
  clickUrl: string
}

export type GoodwaitImpact = {
  cause_name: string | null
  cause_url: string | null
  pledge_pct: number | null
  donated_usd: number
  sponsored_waits: number
}

export type GoodwaitCurrent = {
  id: string
  turnId: string
  ad: GoodwaitAd
  impact: GoodwaitImpact
  sandbox: boolean
  impressed: boolean
}

export type GoodwaitLeader = {
  site_key: string
  name: string | null
  sponsored_waits: number
}

export type GoodwaitStats = {
  total: { sponsored_waits: number; paid_waits: number; clicks: number; sites: number }
  site: { site_key: string; name: string | null; sponsored_waits: number; paid_waits: number; clicks: number } | null
  leaderboard: GoodwaitLeader[]
  impact: GoodwaitImpact
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'goodwait': {
      current: GoodwaitCurrent | null
      isHidden: boolean
      sessionWaits: number
      sessionPaid: number
      stats: GoodwaitStats | null
    }
  }
}
