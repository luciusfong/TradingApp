# TradingApp

US market data, news sentiment, screens and paper trading for Android. No server: everything runs on the phone.

- **Watchlist** (starts empty) with quotes, daily change and a sentiment tape (one bar per recent headline). Futures and the dollar index can be added by broker-style names: `CLmain`, `NQmain`, `UBmain`, `GCmain`, `ESmain`, `USDindex`.
- **Ticker page** with price chart (1D to 1Y) and scored, de-duplicated headlines.
- **Local currency** (Settings, off by default): adds each price and today's change converted to a chosen currency, so the change includes the exchange-rate move. `toLocal` in `src/lib/market.ts`.
- **Screener** with four tabs. Each tab's rules are adjustable filters whose defaults are the published rules; the list shows what matches, with the rest one tap away. Filter definitions in `src/lib/filters.ts`.
  - Macro: liquidity read from bonds and the dollar, cross-asset trends (fast and slow averages, trend filter).
  - Quant: z-score, RSI(2) and momentum signals over the watchlist or 30 large caps.
  - Technical: Minervini trend template for stocks, Turtle-style breakout rule for futures.
  - Fundamental: Lynch PEG plus Buffett-style quality checks, from Finnhub basic financials (needs the free key).
  - Rules in `src/lib/screen.ts` and `src/lib/fundamentals.ts`.
- **Screener alerts** (Settings, off by default): about once an hour an Android background job re-runs the Macro, Quant and Technical screens with your filters and notifies you of matches that were not there on its previous run. See "Native code" below.
- **Market news** with an overall mood score, limited to the last 3 days. Headlines are sorted into categories (`categoryOf` in `src/lib/news.ts`) and rolled up into Filings (SEC filings, FDA approvals, insider, institutional), News (geopolitical, tech, financial, economics), Corporate (M&A, IPOs, private markets, corporate funds) and Other. Private markets covers private equity and venture capital: funding rounds, buyouts, fund raises.
- **Trading** tab with Paper, Live and Wise.
  - Paper is a $100,000 pretend account (long and short, stocks and the listed futures with contract multipliers, simplified margin, fills at the latest quote) with a position breakdown; logic in `src/lib/paper.ts`.
  - Live is a read-only view of an Interactive Brokers account. It cannot place orders. See "IBKR" below.
  - Wise shows your Wise balances. Withdraw drafts a transfer to a saved bank recipient; Deposit shows the bank details that pay into each balance, to copy into your bank app. The app cannot pay for a transfer. See "Wise" below.
- **Backup** (Settings): saves the watchlist, settings, Screener filters and paper account as a file through Android's share sheet (Google Drive, OneDrive, Gmail and so on) and restores from such a file. Keys and tokens are left out. `src/lib/backup.ts`.
- **Home-screen widget:** one widget with Watchlist, Positions (paper account) and News tabs. Android widgets cannot be swiped sideways, so tabs are tapped. It fetches quotes and headlines itself about every 30 minutes; tap the time to refresh.
- **Sentiment** is scored on the phone with a finance word-and-phrase list (`src/lib/sentiment.ts`).
- Explanations of the screens and financial terms are hidden by default; the Info button (Screener, Trading) or Settings turns them on.

## Data sources

| Data | Source | Key |
|---|---|---|
| Quotes, charts, exchange rates | Yahoo Finance chart endpoint (unofficial) | none |
| Real-time quotes, company news, fundamentals | Finnhub | optional free key, entered in Settings |
| Headlines | Google News RSS | none |
| Live account and positions | IBKR Client Portal Gateway | gateway address, entered in Settings |
| Wise balances, recipients, quotes, draft transfers | Wise API | personal API token, entered in Settings |

## IBKR

Interactive Brokers gives individual accounts no API key. Their Web API is reached through the Client Portal Gateway, a Java program you download from IBKR, run on a computer and log in to in a browser on that computer. IBKR requires a fresh login about once a day, and an idle session times out after a few minutes; the app pings the gateway while the Live tab is in use.

The Settings field takes the address of that gateway, and "Test connection" checks it. Two things stand between a phone and the gateway:

- The gateway ships with a self-signed certificate, which Android rejects, and the app only makes HTTPS requests.
- IBKR's documentation says API calls are to be made on the machine where the gateway was logged in.

So the phone needs an HTTPS address with a trusted certificate that lives on that computer and forwards to the gateway (`https://localhost:5000`), for example Tailscale Serve or a reverse proxy with a real certificate. This path has not been tested against a real gateway yet. The code is `src/lib/ibkr.ts`: it calls `/tickle`, `/portfolio/accounts`, `/portfolio/{account}/summary` and `/portfolio/{account}/positions/{page}`, all read-only.

## Wise

The Wise tab works with a personal API token, created in Wise under Settings, Integrations and tools, API tokens. The code is `src/lib/wise.ts`.

What it does: lists profiles, balances and saved recipients, asks Wise for a quote, creates the transfer (which Wise holds as "waiting for payment"), lists such drafts and cancels one. What it cannot do: pay for a transfer. `wise.ts` contains no funding call, so money moves only when you open Wise and pay for the draft there; Wise cancels drafts left unpaid. New recipients are added in Wise, not in the app, and routes that need extra details (a transfer purpose, for instance) have to be made in Wise.

The token is checked with Wise before it is stored. It is kept in Capacitor Preferences, apart from the settings, so it is never in a backup file, and `native/res/xml/backup_rules.xml` and `data_extraction_rules.xml` keep that store out of Android's cloud backup and phone-to-phone transfer. It is still a credential stored on the phone by a debug build: treat it like a password and revoke it in Wise if the phone is lost. "Test mode" in Settings points the app at Wise's sandbox (`api.wise-sandbox.com`) for trying the flow with a sandbox token.

None of this has been run against Wise yet; it follows Wise's API reference and is exercised in tests and in the browser against a mock.

## Native code

The Android project is generated in CI by Capacitor (`npx cap add android`); it is not committed. The app's own native code lives in `native/` and is copied into the generated project, and registered in its manifest, by `scripts/add-native.mjs`:

- `TradingWidget` and the `*Page` classes: the home-screen widget.
- `ScreenerJob`, `ScreenerCheck`: the hourly alert job. It reads the symbols and filters the app mirrors into Capacitor Preferences (`alertConfig` in `src/lib/native.ts`).
- `Screens.java`: the Screener's rules again, in Java, because the job runs without the web app. `tests/crosscheck.test.ts` writes `native/test/fixture.txt` (generated prices, filters and the alert keys the TypeScript rules produce) and `native/test/CrossCheck.java` checks that the Java rules produce the same keys. If you change a rule, regenerate the fixture with `UPDATE_FIXTURE=1 npm test` and bring `Screens.java` in line.

## Get the APK

Every push to `main` runs **Build APK** in GitHub Actions and publishes the result under **Releases**. Open the latest release on your phone, download the `.apk`, and allow your browser to install apps when Android asks.

## Develop

```
npm install
npm test             # rules, parsers, paper account, filters
npm run test:native  # Java alert rules against the TypeScript ones (needs a JDK)
npm run dev          # UI in a browser (live data needs the phone build)
```

`signing/debug.keystore` is a debug-grade key kept in the repo so each build can install over the previous one. Anyone who has this key can sign an app that installs over yours and reads its data, including a stored Wise token, so keep the repository private or replace the key with a private one (kept as a GitHub secret) before storing real credentials in the app.
