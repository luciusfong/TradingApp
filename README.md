# TradingApp

US market data and news sentiment for Android. Part one of three (news + market data; algorithm; paper/live trading).

- **Watchlist** with quotes, daily change and a sentiment tape (one bar per recent headline).
- **Ticker page** with price chart (1D to 1Y) and scored, de-duplicated headlines.
- **Screener** with a macro view (liquidity read from bonds and the dollar, cross-asset trends) and a quant view (z-score, RSI(2), momentum signals) over the watchlist or 30 large caps. Logic in `src/lib/screen.ts`.
- **Market news** with an overall mood score.
- Futures and the dollar index can be added by broker-style names: `CLmain`, `NQmain`, `UBmain`, `GCmain`, `ESmain`, `USDindex`.
- **Sentiment** is scored on the phone with a finance word-and-phrase list (`src/lib/sentiment.ts`). No server.

## Data sources

| Data | Source | Key |
|---|---|---|
| Quotes, charts | Yahoo Finance chart endpoint (unofficial) | none |
| Real-time quotes, company news | Finnhub | optional free key, entered in Settings |
| Headlines | Google News RSS | none |

## Get the APK

Every push to `main` runs **Build APK** in GitHub Actions and publishes the result under **Releases**. Open the latest release on your phone, download the `.apk`, and allow your browser to install apps when Android asks.

## Develop

```
npm install
npm test        # sentiment, parsers, dedupe
npm run dev     # UI in a browser (live data needs the phone build)
```

The Android project is generated in CI by Capacitor (`npx cap add android`); it is not committed. `signing/debug.keystore` is a debug-grade key kept in the repo so each build can install over the previous one. Replace it with a private release key before distributing the app.
