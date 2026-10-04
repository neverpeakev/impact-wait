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

declare module 'claude-code' {
  interface PluginState {
    'goodwait': { current: GoodwaitCurrent | null; isHidden: boolean }
  }
}
