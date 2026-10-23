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

// An ad the mod fetched straight from a network that is called from the viewer's
// own device (Velocity). The mod fires its impression URL and reports the view.
export type GoodwaitExternal = {
  network: 'velocity'
  requestId: string
  adId: string | null
  impressionUrl: string
}

export type GoodwaitCurrent = {
  id: string
  turnId: string
  ad: GoodwaitAd
  impact: GoodwaitImpact
  sandbox: boolean
  impressed: boolean
  external?: GoodwaitExternal | null
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
  program: { share_pct: number; referral_pct?: number; min_payout_usd: number; hold_days?: number; daily_cap: number; min_gap_seconds: number; est_ecpm_usd: number | null }
  // Present once the balance model is live on the server; older servers leave them out.
  balance_usd?: number
  donated_usd?: number
  referral_code?: string
  referrals?: number
  referral_earned_usd?: number
  auto_exit?: 'cash' | 'donate'
  cash_out_from?: string | null
  // Whether this install is linked to a vibedough.com account (servers before accounts leave it out).
  account_linked?: boolean
  draw?: { name: string; prize_usd: number; closes_at: string; rules_url: string | null; entries: number } | null
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
