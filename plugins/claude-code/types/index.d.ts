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

// Actual publisher earnings as a network's dashboard reported them, newest report per network.
export type GoodwaitEarning = {
  network: string
  site_key: string | null
  earned_usd: number
  paid_waits: number | null
  clicks: number | null
  as_of: string
  source: string
}

export type GoodwaitStats = {
  total: { sponsored_waits: number; paid_waits: number; clicks: number; sites: number }
  site: { site_key: string; name: string | null; sponsored_waits: number; paid_waits: number; clicks: number } | null
  leaderboard: GoodwaitLeader[]
  impact: GoodwaitImpact
  earnings: GoodwaitEarning[]
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
