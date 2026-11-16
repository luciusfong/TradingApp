// Read-only link to an Interactive Brokers account through the Client Portal
// Gateway, the program IBKR provides for individual accounts. The gateway runs
// on the user's computer, where they log in; this app only reads from it and
// never sends an order.
import { httpGet, httpPost, HttpError } from './http';

// Accepts what people type ("192.168.1.20:5000", a full URL, a URL ending in /v1/api) and returns the gateway's origin.
export function gatewayBase(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.hostname ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}
const api = (base: string, path: string) => `${base}/v1/api${path}`;

export interface IbkrAccount { id: string; title: string; currency: string }
export interface LivePosition {
  key: string; symbol: string; desc: string; qty: number; price: number; value: number; avgCost: number;
  pnl: number; pnlPct: number | null; currency: string; assetClass: string;
}
export interface LiveSummary { netLiq: number | null; cash: number | null; buyingPower: number | null; available: number | null; currency: string }
export interface LivePortfolio { summary: LiveSummary; positions: LivePosition[] }

const n = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseAccounts(d: any): IbkrAccount[] {
  if (!Array.isArray(d)) return [];
  return d
    .map((a) => ({ id: str(a?.accountId) || str(a?.id), title: str(a?.accountTitle) || str(a?.displayName), currency: str(a?.currency) }))
    .filter((a) => a.id);
}

export function parsePositions(d: any): LivePosition[] {
  if (!Array.isArray(d)) return [];
  const out: LivePosition[] = [];
  for (const p of d) {
    const qty = n(p?.position);
    if (!qty) continue; // closed positions linger in the list with a size of zero
    const avgCost = n(p?.avgCost) ?? 0;
    const pnl = n(p?.unrealizedPnl) ?? 0;
    const cost = Math.abs(qty) * avgCost;
    const desc = str(p?.contractDesc);
    out.push({
      key: String(p?.conid ?? desc),
      symbol: str(p?.ticker) || desc.split(' ')[0] || '?',
      desc,
      qty,
      price: n(p?.mktPrice) ?? 0,
      value: n(p?.mktValue) ?? 0,
      avgCost,
      pnl,
      pnlPct: cost ? (pnl / cost) * 100 : null,
      currency: str(p?.currency),
      assetClass: str(p?.assetClass),
    });
  }
  return out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

// The summary is an object of { amount, currency, ... } entries with lower-case keys.
export function parseSummary(d: any): LiveSummary {
  const amt = (k: string) => n(d?.[k]?.amount);
  return {
    netLiq: amt('netliquidation'),
    cash: amt('totalcashvalue'),
    buyingPower: amt('buyingpower'),
    available: amt('availablefunds'),
    currency: str(d?.netliquidation?.currency) || str(d?.totalcashvalue?.currency),
  };
}

// Turns the many ways a home-network connection can fail into something actionable.
export function gatewayError(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401) return 'The gateway is running but not logged in. Log in on the computer that runs it, then try again.';
    if (e.status === 403) return "The gateway refused this phone. Its allow-list (ips in conf.yaml) does not include this phone's address.";
    return `The gateway answered with an error (${e.status}).`;
  }
  const m = e instanceof Error ? e.message : String(e);
  if (/cleartext/i.test(m)) return 'This address starts with http:// and Android blocked it. Use an https:// address.';
  if (/trust anchor|certificate|certpath|handshake|ssl/i.test(m)) return "Android does not trust the gateway's security certificate. The gateway ships with a self-signed one, so it needs a trusted HTTPS address in front of it (see the IBKR notes in the README).";
  if (/failed to connect|refused|unreachable|timeout|timed out|unable to resolve|no route|network|failed to fetch|no address/i.test(m)) return 'Could not reach the gateway. Check that it is running, that the address and port are right, and that this phone can reach that computer.';
  return m || 'Could not reach the gateway.';
}

export async function ibkrAccounts(base: string): Promise<IbkrAccount[]> {
  // Keeps the gateway session from idling out; harmless if it fails.
  await httpPost(api(base, '/tickle')).catch(() => undefined);
  const d = await httpGet(api(base, '/portfolio/accounts'), 'json');
  const accounts = parseAccounts(d);
  if (!accounts.length) throw new Error('The gateway answered, but listed no accounts.');
  return accounts;
}

// The accounts call above must come first: IBKR requires it before any other portfolio request.
export async function ibkrPortfolio(base: string, accountId: string): Promise<LivePortfolio> {
  const id = encodeURIComponent(accountId);
  const summary = parseSummary(await httpGet(api(base, `/portfolio/${id}/summary`), 'json'));
  const raw: any[] = [];
  for (let page = 0; page < 20; page++) {
    const d = await httpGet(api(base, `/portfolio/${id}/positions/${page}`), 'json');
    if (!Array.isArray(d) || d.length === 0) break;
    raw.push(...d);
    if (d.length < 30) break; // a short page is the last one
  }
  return { summary, positions: parsePositions(raw) };
}
