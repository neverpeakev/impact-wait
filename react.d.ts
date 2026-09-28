import type { CSSProperties } from "react";
export interface ImpactWaitProps {
  /** Your app's key: 2-41 chars, a-z, 0-9, dash. New keys register automatically. */
  site: string;
  /** true while the model is generating. */
  active: boolean;
  /** The user's latest message; used to match a relevant sponsor. */
  query: string;
  /** Optional: the reply so far, for better matching. */
  response?: string;
  endpoint?: string;
  /** ms to keep the line up after `active` goes false (default 4000). */
  linger?: number;
  theme?: "light" | "dark";
  className?: string;
  style?: CSSProperties;
  onAd?: (d: { provider: string; id: string }) => void;
  onImpression?: (d: { provider: string; id: string }) => void;
}
export declare function ImpactWait(props: ImpactWaitProps): JSX.Element;
export default ImpactWait;
