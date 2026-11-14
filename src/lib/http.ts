import { Capacitor, CapacitorHttp } from '@capacitor/core';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// On the phone, requests go through the native HTTP layer so news and quote
// sites that send no CORS headers still work. In a desktop browser it falls
// back to fetch (which those sites will block; that path is for UI work only).
export async function httpGet(url: string, as: 'json' | 'text'): Promise<any> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'application/rss+xml, text/xml, */*' },
      responseType: as === 'json' ? 'json' : 'text',
      connectTimeout: 12000,
      readTimeout: 15000,
    });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, describe(res.status));
    if (as === 'json' && typeof res.data === 'string') {
      try { return JSON.parse(res.data); } catch { throw new HttpError(res.status, 'Unexpected response from server'); }
    }
    if (as === 'text' && typeof res.data !== 'string') return JSON.stringify(res.data);
    return res.data;
  }
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status, describe(res.status));
  return as === 'json' ? res.json() : res.text();
}

function describe(status: number): string {
  if (status === 401 || status === 403) return 'Access refused. Check the API key in Settings.';
  if (status === 429) return 'Rate limit reached. Wait a minute and refresh.';
  if (status === 404) return 'Not found. Check the ticker symbol.';
  return `Server returned ${status}.`;
}

export function errorText(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|network|unable to resolve|timeout|timed out/i.test(m)) return 'No connection. Check the internet and refresh.';
  return m || 'Something went wrong.';
}
