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

// This install's own earnings, from GET /earner/me. Money is owed only from settled network revenue.
export type GoodwaitEarner = {
  earner_id: string
  status: string
  credited_total: number
  credited_today: number
  pending_waits: number
  owed_usd: number
  paid_usd: number
  payout_email: string | null
  est_pending_usd: number | null
  program: { share_pct: number; min_payout_usd: number; daily_cap: number; min_gap_seconds: number; est_ecpm_usd: number | null }
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
      earner: GoodwaitEarner | null
    }
  }
}
