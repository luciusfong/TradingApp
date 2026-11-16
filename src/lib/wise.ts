// Link to a Wise account through a personal API token.
//
// What this module can do: read profiles, balances and saved recipients, ask
// for a quote, create a transfer as a draft, list drafts and cancel a draft.
// What it deliberately cannot do: pay for ("fund") a transfer. There is no
// such call in this file, so nothing the app does can move money on its own.
// A draft sits in Wise as "waiting for payment" until the account owner pays
// for it inside Wise's own app or site, and Wise cancels drafts left unpaid.
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface WiseLink { token: string; sandbox: boolean }
const HOST = { live: 'https://api.wise.com', sandbox: 'https://api.wise-sandbox.com' };
export const wiseSite = (link: WiseLink) => (link.sandbox ? 'https://wise-sandbox.com/' : 'https://wise.com/home');

export class WiseError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

// Wise reports problems in several shapes; this pulls out whatever message it gave.
export function wiseMessage(status: number, body: any): string {
  const parts: string[] = [];
  if (Array.isArray(body?.errors)) for (const e of body.errors) if (str(e?.message)) parts.push(str(e.message));
  if (!parts.length && str(body?.message)) parts.push(str(body.message));
  if (!parts.length && str(body?.error_description)) parts.push(str(body.error_description));
  const detail = [...new Set(parts)].join(' ');
  if (status === 401) return 'Wise did not accept the token. Check that it was copied in full and has not been revoked.';
  if (status === 403) return `Wise refused this request${detail ? ` (${detail})` : ''}. If the token is read-only it can show balances but cannot draft transfers.`;
  if (status === 429) return 'Wise is limiting requests. Wait a minute and try again.';
  if (status === 400 || status === 422) return detail ? `Wise could not accept this: ${detail}` : 'Wise could not accept this request.';
  return detail ? `Wise answered with an error (${status}): ${detail}` : `Wise answered with an error (${status}).`;
}

export function wiseErrorText(e: unknown): string {
  if (e instanceof WiseError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|network|unable to resolve|timeout|timed out|failed to connect|no address/i.test(m)) return 'Could not reach Wise. Check the internet connection and try again.';
  return m || 'Something went wrong talking to Wise.';
}

async function call(link: WiseLink, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
  const url = `${link.sandbox ? HOST.sandbox : HOST.live}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${link.token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let status: number;
  let data: any;
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({ url, method, headers, data: body, responseType: 'json', connectTimeout: 15000, readTimeout: 20000 });
    status = res.status;
    data = res.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* an error page in plain text; the status says enough */ }
    }
  } else {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    data = await res.json().catch(() => null);
  }
  if (status < 200 || status >= 300) throw new WiseError(status, wiseMessage(status, data));
  return data;
}

// ---------- Reading ----------

export interface WiseProfile { id: number; type: 'personal' | 'business'; name: string }
export function parseProfiles(d: any): WiseProfile[] {
  if (!Array.isArray(d)) return [];
  const out: WiseProfile[] = [];
  for (const p of d) {
    const id = num(p?.id);
    if (!id) continue;
    const old = p?.details ?? {}; // the first version of the API nests the name under "details"
    const person = [str(p?.firstName) || str(old.firstName), str(p?.lastName) || str(old.lastName)].filter(Boolean).join(' ');
    const type = str(p?.type).toLowerCase() === 'business' ? 'business' : 'personal';
    out.push({ id, type, name: (type === 'business' ? str(p?.businessName) || str(old.name) : '') || str(p?.fullName) || person || `Profile ${id}` });
  }
  return out;
}

export interface WiseBalance { id: number; currency: string; amount: number }
export function parseBalances(d: any): WiseBalance[] {
  if (!Array.isArray(d)) return [];
  const out: WiseBalance[] = [];
  for (const b of d) {
    const id = num(b?.id);
    const amount = num(b?.amount?.value);
    const currency = str(b?.currency) || str(b?.amount?.currency);
    if (id && amount !== null && currency) out.push({ id, currency, amount });
  }
  return out.sort((a, b) => Number(b.amount > 0) - Number(a.amount > 0) || a.currency.localeCompare(b.currency));
}

export interface WiseRecipient { id: number; name: string; currency: string; summary: string; own: boolean }
export function parseRecipients(d: any): WiseRecipient[] {
  const list = Array.isArray(d) ? d : Array.isArray(d?.content) ? d.content : [];
  const out: WiseRecipient[] = [];
  for (const r of list) {
    const id = num(r?.id);
    const currency = str(r?.currency);
    if (!id || !currency || r?.active === false) continue;
    out.push({
      id, currency,
      name: str(r?.name?.fullName) || str(r?.accountHolderName) || `Recipient ${id}`,
      summary: str(r?.longAccountSummary) || str(r?.accountSummary),
      own: r?.ownedByCustomer === true,
    });
  }
  return out;
}

export interface WiseTransfer {
  id: number; status: string; recipientId: number | null; reference: string; created: string;
  sourceCurrency: string; sourceAmount: number | null; targetCurrency: string; targetAmount: number | null;
}
export function parseTransfer(t: any): WiseTransfer | null {
  const id = num(t?.id);
  if (!id) return null;
  return {
    id, status: str(t?.status), recipientId: num(t?.targetAccount), reference: str(t?.details?.reference) || str(t?.reference), created: str(t?.created),
    sourceCurrency: str(t?.sourceCurrency), sourceAmount: num(t?.sourceValue), targetCurrency: str(t?.targetCurrency), targetAmount: num(t?.targetValue),
  };
}
export const parseTransfers = (d: any): WiseTransfer[] => (Array.isArray(d) ? d.map(parseTransfer).filter((t): t is WiseTransfer => t !== null) : []);

export const wiseProfiles = async (link: WiseLink) => parseProfiles(await call(link, 'GET', '/v2/profiles'));
export const wiseBalances = async (link: WiseLink, profileId: number) => parseBalances(await call(link, 'GET', `/v4/profiles/${profileId}/balances?types=STANDARD`));
// Recipients come 20 to a page; five pages is plenty for a personal account.
export async function wiseRecipients(link: WiseLink, profileId: number): Promise<WiseRecipient[]> {
  const out: WiseRecipient[] = [];
  let seek: number | null = null;
  for (let page = 0; page < 5; page++) {
    const d: any = await call(link, 'GET', `/v2/accounts?profileId=${profileId}&profile=${profileId}&active=true&size=20${seek === null ? '' : `&seekPosition=${seek}`}`);
    const rows = parseRecipients(d);
    out.push(...rows);
    seek = num(d?.seekPositionForNext);
    if (rows.length < 20 || seek === null) break;
  }
  return out;
}
/** Drafts that have been created but not paid for. */
export const wiseDrafts = async (link: WiseLink, profileId: number) =>
  parseTransfers(await call(link, 'GET', `/v1/transfers?profile=${profileId}&status=incoming_payment_waiting&limit=10&offset=0`));

// ---------- Quote, draft, cancel ----------

export interface WiseQuote {
  id: string; sourceCurrency: string; targetCurrency: string;
  sourceAmount: number; targetAmount: number; fee: number; rate: number;
  delivery: string; expires: string;
  blocked: string | null; // why this quote cannot be paid from a balance, if it cannot
  notices: string[];
}
// A quote lists one option per way of paying. Only "from a Wise balance" is used here.
export function parseQuote(d: any): WiseQuote | null {
  const id = str(d?.id);
  const options: any[] = Array.isArray(d?.paymentOptions) ? d.paymentOptions : [];
  const fromBalance = options.filter((o) => str(o?.payIn).toUpperCase() === 'BALANCE');
  const opt = fromBalance.find((o) => str(o?.payOut) === str(d?.payOut)) ?? fromBalance[0];
  const notices: any[] = Array.isArray(d?.notices) ? d.notices : [];
  if (!id) return null;
  if (!opt) {
    return {
      id, sourceCurrency: str(d?.sourceCurrency), targetCurrency: str(d?.targetCurrency), sourceAmount: num(d?.sourceAmount) ?? 0, targetAmount: num(d?.targetAmount) ?? 0,
      fee: 0, rate: num(d?.rate) ?? 0, delivery: '', expires: str(d?.expirationTime), notices: [], blocked: 'Wise does not offer paying for this transfer from a balance.',
    };
  }
  const sourceAmount = num(opt.sourceAmount);
  const targetAmount = num(opt.targetAmount);
  const fee = num(opt.fee?.total);
  if (sourceAmount === null || targetAmount === null || fee === null) return null;
  const stop = notices.find((n) => str(n?.type).toUpperCase() === 'BLOCKED');
  return {
    id,
    sourceCurrency: str(opt.sourceCurrency) || str(d?.sourceCurrency),
    targetCurrency: str(opt.targetCurrency) || str(d?.targetCurrency),
    sourceAmount, targetAmount, fee,
    rate: num(d?.rate) ?? 0,
    delivery: str(opt.formattedEstimatedDelivery),
    expires: str(d?.expirationTime),
    blocked: opt.disabled === true ? str(opt.disabledReason?.message) || 'Wise has switched off paying from a balance for this transfer.' : stop ? str(stop.text) || 'Wise has blocked this transfer.' : null,
    notices: notices.filter((n) => n !== stop).map((n) => str(n?.text)).filter(Boolean),
  };
}

export async function wiseQuote(link: WiseLink, profileId: number, q: { sourceCurrency: string; targetCurrency: string; sourceAmount: number; recipientId: number }): Promise<WiseQuote> {
  const quote = parseQuote(await call(link, 'POST', `/v3/profiles/${profileId}/quotes`, {
    sourceCurrency: q.sourceCurrency, targetCurrency: q.targetCurrency, sourceAmount: q.sourceAmount, targetAccount: q.recipientId, preferredPayIn: 'BALANCE',
  }));
  if (!quote) throw new Error('Wise returned a quote this app could not read.');
  return quote;
}

// `key` identifies this attempt. Sending the same key again (after a timeout, say) cannot create a second transfer.
export async function wiseDraft(link: WiseLink, d: { recipientId: number; quoteId: string; key: string; reference: string }): Promise<WiseTransfer> {
  const transfer = parseTransfer(await call(link, 'POST', '/v1/transfers', {
    targetAccount: d.recipientId, quoteUuid: d.quoteId, customerTransactionId: d.key, details: d.reference ? { reference: d.reference } : {},
  }));
  if (!transfer) throw new Error('Wise accepted the request but returned no transfer. Check Wise before trying again.');
  return transfer;
}

/** Wise only allows this while a transfer is still waiting for payment. */
export const wiseCancel = async (link: WiseLink, transferId: number) => parseTransfer(await call(link, 'PUT', `/v1/transfers/${transferId}/cancel`));

export function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
  });
}
