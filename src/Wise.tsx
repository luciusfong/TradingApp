import { useCallback, useEffect, useRef, useState } from 'react';
import {
  newKey, wiseAccountDetails, wiseBalances, wiseCancel, wiseDraft, wiseDrafts, wiseErrorText, wiseProfiles, wiseQuote, wiseRecipients, wiseSite,
  type WiseAccountDetails, type WiseBalance, type WiseLink, type WiseProfile, type WiseQuote, type WiseRecipient, type WiseTransfer,
} from './lib/wise';

const money = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function WiseView({ link, onSettings, info }: { link: WiseLink | null; onSettings: () => void; info: boolean }) {
  if (!link) {
    return (
      <div className="empty-state">
        <b>Wise is not connected</b>
        <span>Add a Wise API token in Settings to see your balances here and draft transfers to your saved bank recipients. You approve and pay each transfer inside Wise.</span>
        <button className="btn" onClick={onSettings}>Open Settings</button>
      </div>
    );
  }
  return <Connected link={link} info={info} />;
}

function Connected({ link, info }: { link: WiseLink; info: boolean }) {
  const [profiles, setProfiles] = useState<WiseProfile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [balances, setBalances] = useState<WiseBalance[]>([]);
  const [recipients, setRecipients] = useState<WiseRecipient[]>([]);
  const [drafts, setDrafts] = useState<WiseTransfer[]>([]);
  const [mode, setMode] = useState<'withdraw' | 'deposit'>('withdraw');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [from, setFrom] = useState('');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [reference, setReference] = useState('');
  const [quote, setQuote] = useState<WiseQuote | null>(null);
  const [busy, setBusy] = useState<'' | 'quote' | 'draft' | 'cancel'>('');
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState<WiseTransfer | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null);
  // One key per quote: tapping "Create draft" again after a timeout cannot create a second transfer.
  const key = useRef('');

  const load = useCallback(async (pick?: number) => {
    setLoading(true);
    setError('');
    try {
      const all = await wiseProfiles(link);
      if (!all.length) throw new Error('Wise listed no profiles for this token.');
      const id = pick && all.some((p) => p.id === pick) ? pick : (all.find((p) => p.type === 'personal') ?? all[0]).id;
      setProfiles(all);
      setProfileId(id);
      const [b, r, d] = await Promise.all([wiseBalances(link, id), wiseRecipients(link, id), wiseDrafts(link, id).catch(() => [])]);
      setBalances(b);
      setRecipients(r);
      setDrafts(d);
      setFrom((cur) => (b.some((x) => x.currency === cur) ? cur : b[0]?.currency ?? ''));
      setTo((cur) => (r.some((x) => String(x.id) === cur) ? cur : ''));
    } catch (e) {
      setError(wiseErrorText(e));
    }
    setLoading(false);
  }, [link]);
  useEffect(() => { load(); }, [load]);

  const balance = balances.find((b) => b.currency === from);
  const recipient = recipients.find((r) => String(r.id) === to);
  const value = Number(amount);
  const ready = !!balance && !!recipient && amount.trim() !== '' && isFinite(value) && value > 0;
  const nameOf = (id: number | null) => recipients.find((r) => r.id === id)?.name ?? 'a saved recipient';
  // Any change to the form throws the quote away, so a draft can only be made from the numbers on screen.
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setQuote(null); setFormError(''); };

  const getQuote = async () => {
    if (!ready || !balance || !recipient || profileId === null) return;
    setBusy('quote');
    setFormError('');
    setQuote(null);
    setDone(null);
    try {
      const q = await wiseQuote(link, profileId, { sourceCurrency: balance.currency, targetCurrency: recipient.currency, sourceAmount: value, recipientId: recipient.id });
      key.current = newKey();
      // A quote that is not for exactly what was asked is never turned into a draft.
      const mismatch = q.sourceCurrency !== balance.currency || q.targetCurrency !== recipient.currency || Math.abs(q.sourceAmount - value) > 0.005;
      setQuote(mismatch ? { ...q, blocked: 'The quote Wise returned does not match what was asked for, so no draft can be made from it. Try again, or make this transfer in Wise.' } : q);
    } catch (e) {
      setFormError(wiseErrorText(e));
    }
    setBusy('');
  };

  const createDraft = async () => {
    if (!quote || quote.blocked || !recipient || profileId === null) return;
    setBusy('draft');
    setFormError('');
    try {
      const t = await wiseDraft(link, { recipientId: recipient.id, quoteId: quote.id, key: key.current, reference: reference.trim().slice(0, 35) });
      setDone({ ...t, sourceAmount: t.sourceAmount ?? quote.sourceAmount, sourceCurrency: t.sourceCurrency || quote.sourceCurrency, targetAmount: t.targetAmount ?? quote.targetAmount, targetCurrency: t.targetCurrency || quote.targetCurrency });
      setQuote(null);
      setAmount('');
      setReference('');
      wiseDrafts(link, profileId).then(setDrafts).catch(() => { /* the list is refreshed on the next visit */ });
    } catch (e) {
      setFormError(wiseErrorText(e));
    }
    setBusy('');
  };

  const cancel = async (id: number) => {
    if (confirmCancel !== id) { setConfirmCancel(id); return; }
    if (profileId === null) return;
    setConfirmCancel(null);
    setBusy('cancel');
    setError('');
    try {
      await wiseCancel(link, id);
      if (done?.id === id) setDone(null);
      setDrafts(await wiseDrafts(link, profileId));
    } catch (e) {
      setError(wiseErrorText(e));
    }
    setBusy('');
  };

  return (
    <>
      {link.sandbox && <p className="note"><b>Test mode.</b> This is Wise's sandbox. No real money is involved.</p>}
      <div className="section-h">
        <h2>
          Wise balances
          {profiles.length > 1 && profileId !== null && (
            <select className="acct-pick" value={profileId} aria-label="Wise profile" onChange={(e) => { setQuote(null); setDone(null); load(Number(e.target.value)); }}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </h2>
        <button onClick={() => load(profileId ?? undefined)}>{loading ? 'Loading' : 'Refresh'}</button>
      </div>
      {error && <div className="err">{error}</div>}
      {balances.length > 0 && (
        <ul className="ledger">
          {balances.map((b) => (
            <li key={b.id} className="trade num"><span><b>{b.currency}</b></span><span className="amt">{money(b.amount)}</span></li>
          ))}
        </ul>
      )}
      {!loading && !error && balances.length === 0 && <p className="note">This Wise profile has no balances.</p>}

      {!error && profileId !== null && (
        <div className="ranges" role="group" aria-label="Direction">
          <button aria-pressed={mode === 'withdraw'} onClick={() => setMode('withdraw')}>Withdraw to bank</button>
          <button aria-pressed={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit to Wise</button>
        </div>
      )}
      {mode === 'deposit' && !error && profileId !== null && <Deposit link={link} profileId={profileId} />}
      {mode === 'withdraw' && !error && (balances.length > 0 || recipients.length > 0) && (
        <>
          <div className="section-h"><h2>Send to a bank account</h2><span className="hint">Draft only</span></div>
          {recipients.length === 0 ? (
            <p className="note">No saved recipients. Add the bank account as a recipient in Wise first; it will then appear here.</p>
          ) : (
            <div className="wform">
              <label>
                From balance
                <select value={from} onChange={(e) => edit(setFrom)(e.target.value)}>
                  {balances.map((b) => <option key={b.id} value={b.currency}>{b.currency}, {money(b.amount)} available</option>)}
                </select>
              </label>
              <label>
                Amount to send{from ? `, in ${from}` : ''}
                <input value={amount} onChange={(e) => edit(setAmount)(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" inputMode="decimal" autoComplete="off" />
              </label>
              <label>
                To
                <select value={to} onChange={(e) => edit(setTo)(e.target.value)}>
                  <option value="">Choose a saved recipient</option>
                  {recipients.map((r) => <option key={r.id} value={r.id}>{r.name}, {r.summary || r.currency}</option>)}
                </select>
              </label>
              <label>
                Reference (optional)
                <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={35} autoComplete="off" />
              </label>
              <button className="btn" disabled={!ready || busy !== ''} onClick={getQuote}>{busy === 'quote' ? 'Getting quote' : quote ? 'Refresh quote' : 'Get quote'}</button>
            </div>
          )}
        </>
      )}
      {mode === 'withdraw' && formError && <div className="err">{formError}</div>}

      {mode === 'withdraw' && quote && recipient && (
        <div className="card">
          <dl className="kv one num">
            <div><dt>You send</dt><dd>{money(quote.sourceAmount)} {quote.sourceCurrency}</dd></div>
            <div><dt>Wise fee, taken from that</dt><dd>{money(quote.fee)} {quote.sourceCurrency}</dd></div>
            {quote.sourceCurrency !== quote.targetCurrency && quote.rate > 0 && <div><dt>Rate</dt><dd>1 {quote.sourceCurrency} = {quote.rate} {quote.targetCurrency}</dd></div>}
            <div><dt>{recipient.name} gets</dt><dd>{money(quote.targetAmount)} {quote.targetCurrency}</dd></div>
            {quote.delivery && <div><dt>Arrives</dt><dd>{quote.delivery}</dd></div>}
          </dl>
          {recipient.summary && <p className="help">To {recipient.summary}.</p>}
          {quote.blocked && <div className="err flush">{quote.blocked}</div>}
          {!quote.blocked && balance && balance.amount < quote.sourceAmount && (
            <p className="help warn">Your {balance.currency} balance is {money(balance.amount)}, less than this transfer. You would need to top it up in Wise before paying.</p>
          )}
          {quote.notices.map((n) => <p key={n} className="help">{n}</p>)}
          <button className="btn" disabled={!!quote.blocked || busy !== ''} onClick={createDraft}>{busy === 'draft' ? 'Creating draft' : 'Create draft in Wise'}</button>
          <p className="help">This creates a draft only. Nothing is sent until you open Wise and pay for it there.</p>
        </div>
      )}

      {done && (
        <div className="card">
          <b>Draft created in Wise</b>
          <span>
            {money(done.sourceAmount)} {done.sourceCurrency} to {nameOf(done.recipientId)}{done.targetAmount !== null ? `, who gets ${money(done.targetAmount)} ${done.targetCurrency}` : ''}.
            Nothing has been sent yet. Open Wise, check the transfer and pay for it there. Wise cancels drafts that are left unpaid.
          </span>
          <a className="btn" href={wiseSite(link)} target="_blank" rel="noreferrer">Open Wise</a>
        </div>
      )}

      {drafts.length > 0 && (
        <>
          <div className="section-h"><h2>Waiting for payment in Wise</h2><span className="hint">{drafts.length}</span></div>
          <ul className="ledger">
            {drafts.map((t) => (
              <li key={t.id} className="trade num">
                <span>
                  <b>{money(t.sourceAmount)} {t.sourceCurrency}</b>{t.targetAmount !== null && t.targetCurrency !== t.sourceCurrency ? ` → ${money(t.targetAmount)} ${t.targetCurrency}` : ''}
                  <br />
                  <span className="flat">To {nameOf(t.recipientId)}{t.reference ? `, "${t.reference}"` : ''}</span>
                </span>
                <button className="link danger" disabled={busy !== ''} onClick={() => cancel(t.id)}>{confirmCancel === t.id ? 'Tap again to cancel' : 'Cancel draft'}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {info && (
        <p className="fine pad">
          The app uses your Wise API token to read balances and saved recipients, ask Wise for a quote and create the transfer as a draft.
          It has no way to pay for a transfer, so money only moves when you approve it in Wise. Quotes expire, and the rate Wise finally applies
          is the one shown in Wise when you pay. New recipients are added in Wise, not here.
        </p>
      )}
    </>
  );
}

// Deposit: show the bank details that pay into each Wise balance, to copy into a bank app.
function Deposit({ link, profileId }: { link: WiseLink; profileId: number }) {
  const [data, setData] = useState<{ ready: WiseAccountDetails[]; notSetUp: string[] } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    wiseAccountDetails(link, profileId).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(wiseErrorText(e)); });
    return () => { live = false; };
  }, [link, profileId]);
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 1500); }).catch(() => undefined);
  };
  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="note">Loading</p>;
  return (
    <>
      <p className="note">To add money, send a bank transfer from your bank's app to these details. The app cannot pull money from your bank.</p>
      {data.ready.length === 0 && <p className="note">No account details are set up on this Wise profile yet. Set them up for a currency in Wise; they will then appear here.</p>}
      {data.ready.map((a) => a.options.map((o) => (
        <div key={a.currency + o.type}>
          <div className="section-h"><h2>{a.currency}{a.name ? `, ${a.name}` : ''}</h2><span className="hint">{o.type === 'LOCAL' ? 'From a local bank' : 'From abroad (SWIFT)'}</span></div>
          <ul className="ledger">
            {o.fields.map((f) => {
              const key = `${a.currency}${o.type}${f.label}`;
              return (
                <li key={key} className="trade num">
                  <span><span className="flat">{f.label}</span><br /><b>{f.value}</b></span>
                  <button className="link" onClick={() => copy(key, f.value)}>{copied === key ? 'Copied' : 'Copy'}</button>
                </li>
              );
            })}
          </ul>
        </div>
      )))}
      {data.notSetUp.length > 0 && <p className="note">Not set up yet in Wise: {data.notSetUp.join(', ')}.</p>}
    </>
  );
}
