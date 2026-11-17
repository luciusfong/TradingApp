package com.zlhng.tradingapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs the paper strategies (sell at a target price, rebalance) while the app is closed.
 *
 * The app keeps a copy of the paper account, the rules and the activity log in
 * Capacitor Preferences under "strategy.state" (src/lib/mirror.ts), with a revision
 * number. This job, started by ScreenerJob about once an hour, prices what the rules
 * need, runs them with Strategies.java, and if anything fills writes the new state back
 * with the next revision and from = "bg". The app adopts it the next time it opens.
 * While the app is on screen the job does nothing: the app runs the rules itself.
 */
final class StrategyCheck {
    static final String KEY = "strategy.state";
    private static final String STORE = "CapacitorStorage";
    private static final String PREFS = "ta_strategy";
    private static final String CHANNEL = "strategies";
    private static final long FOREGROUND_TRUST_MS = 6 * 60 * 60 * 1000L;
    private static final Object LOCK = new Object();

    private StrategyCheck() {}

    private static JSONObject state(Context c) {
        try {
            String raw = c.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(KEY, null);
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** True when background strategies are on and at least one rule is active. */
    static boolean enabled(Context c) {
        JSONObject st = state(c);
        if (st == null || !st.optBoolean("bg", true)) return false;
        JSONArray rules = st.optJSONArray("rules");
        for (int i = 0; rules != null && i < rules.length(); i++) {
            JSONObject r = rules.optJSONObject(i);
            if (r != null && r.optBoolean("on", false)) return true;
        }
        return false;
    }

    static void setForeground(Context c, boolean fg) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("fg", fg).putLong("fgAt", System.currentTimeMillis()).apply();
    }

    private static boolean inForeground(Context c) {
        SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return sp.getBoolean("fg", false) && System.currentTimeMillis() - sp.getLong("fgAt", 0) < FOREGROUND_TRUST_MS;
    }

    static void run(Context c) {
        synchronized (LOCK) {
            try {
                check(c);
            } catch (Exception ignored) {
                // try again on the next run
            }
        }
    }

    private static Double optNum(JSONObject o, String k) {
        return o.isNull(k) || !o.has(k) ? null : o.optDouble(k);
    }

    private static void check(Context c) throws Exception {
        if (inForeground(c) || !enabled(c)) return;
        JSONObject st = state(c);
        long rev = st.optLong("rev", 0);
        JSONObject paper = st.optJSONObject("paper");
        JSONArray rulesJson = st.optJSONArray("rules");
        if (paper == null || rulesJson == null) return;

        Strategies.Account acct = new Strategies.Account();
        acct.start = paper.optDouble("start", 100000);
        acct.cash = paper.optDouble("cash", 0);
        acct.realized = paper.optDouble("realized", 0);
        JSONObject pos = paper.optJSONObject("positions");
        if (pos != null) {
            Iterator<String> keys = pos.keys();
            while (keys.hasNext()) {
                String s = keys.next();
                JSONObject p = pos.getJSONObject(s);
                acct.positions.put(s, new Strategies.Pos(p.getDouble("qty"), p.getDouble("avgCost"), p.optDouble("mult", 1), p.optBoolean("future", false)));
            }
        }
        List<Strategies.Rule> rules = new ArrayList<>();
        for (int i = 0; i < rulesJson.length(); i++) {
            JSONObject j = rulesJson.getJSONObject(i);
            Strategies.Rule r = new Strategies.Rule();
            r.id = j.optString("id");
            r.on = j.optBoolean("on", false);
            r.price = "price".equals(j.optString("kind"));
            if (r.price) {
                r.symbol = j.optString("symbol");
                r.takeProfit = optNum(j, "takeProfit");
                r.stopLoss = optNum(j, "stopLoss");
                Double q = optNum(j, "qty");
                r.qty = q == null ? null : q.intValue();
            } else {
                r.drift = j.optDouble("drift", 5);
                r.auto = j.optBoolean("auto", false);
                r.last = j.has("last") && !j.isNull("last") ? j.optLong("last") : null;
                JSONArray t = j.optJSONArray("targets");
                for (int k = 0; t != null && k < t.length(); k++) {
                    JSONObject x = t.getJSONObject(k);
                    r.symbols.add(x.optString("symbol"));
                    r.weights.add(x.optDouble("weight", 0));
                }
            }
            rules.add(r);
        }

        // Price what the rules need, and the other holdings for the margin check.
        List<String> want = new ArrayList<>(Strategies.symbols(rules));
        for (String s : acct.positions.keySet()) if (!want.contains(s)) want.add(s);
        Map<String, Double> prices = new LinkedHashMap<>();
        for (String s : want) {
            try {
                double p = WidgetData.quote(s).getDouble("p");
                if (p > 0) prices.put(s, p);
            } catch (Exception ignored) {
                // a missing price leaves that rule waiting
            }
        }
        if (prices.isEmpty()) return;

        long now = System.currentTimeMillis();
        Strategies.Result res = Strategies.run(acct, rules, prices, now);
        if (res.fired.isEmpty()) return;

        // The app may have opened, or changed the rules, while prices were loading.
        JSONObject latest = state(c);
        if (inForeground(c) || latest == null || latest.optLong("rev", -1) != rev) return;

        // Write back: account, trades, rule states, activity log.
        JSONObject positions = new JSONObject();
        for (Map.Entry<String, Strategies.Pos> e : res.account.positions.entrySet()) {
            Strategies.Pos p = e.getValue();
            JSONObject o = new JSONObject().put("qty", p.qty).put("avgCost", p.avgCost);
            if (p.mult != 1) o.put("mult", p.mult);
            if (p.future) o.put("future", true);
            positions.put(e.getKey(), o);
        }
        JSONArray trades = new JSONArray();
        for (Strategies.Trade t : res.account.added) {
            JSONObject o = new JSONObject().put("symbol", t.symbol).put("side", t.side).put("qty", t.qty).put("price", t.price).put("time", t.time);
            if (t.pnl != null) o.put("pnl", t.pnl);
            trades.put(o);
        }
        JSONArray oldTrades = paper.optJSONArray("trades");
        for (int i = 0; oldTrades != null && i < oldTrades.length() && trades.length() < 100; i++) trades.put(oldTrades.get(i));
        paper.put("cash", res.account.cash).put("realized", res.account.realized).put("positions", positions).put("trades", trades);

        for (int i = 0; i < rulesJson.length(); i++) {
            JSONObject j = rulesJson.getJSONObject(i);
            Strategies.Rule r = rules.get(i);
            j.put("on", r.on);
            if (!r.price && r.last != null) j.put("last", r.last);
        }
        JSONArray log = new JSONArray();
        List<String> lines = new ArrayList<>();
        for (Strategies.Fired f : res.fired) {
            log.put(new JSONObject().put("ruleId", f.ruleId).put("text", f.text).put("time", f.time).put("ok", f.ok).put("bg", true));
            lines.add(f.text);
        }
        JSONArray oldLog = st.optJSONArray("log");
        for (int i = 0; oldLog != null && i < oldLog.length() && log.length() < 30; i++) log.put(oldLog.get(i));

        st.put("paper", paper).put("rules", rulesJson).put("log", log).put("rev", rev + 1).put("from", "bg");
        c.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString(KEY, st.toString()).putString("widget.paper", widgetPaper(c, res.account)).commit();
        TradingWidget.renderAll(c);
        notify(c, lines);
    }

    /** Same shape as widgetPaper() in src/lib/native.ts, keeping the labels the app gave each symbol. */
    private static String widgetPaper(Context c, Strategies.Account a) throws Exception {
        Map<String, String> labels = new LinkedHashMap<>();
        JSONObject old = WidgetData.paper(c);
        JSONArray op = old == null ? null : old.optJSONArray("positions");
        for (int i = 0; op != null && i < op.length(); i++) {
            JSONObject o = op.optJSONObject(i);
            if (o != null) labels.put(o.optString("s"), o.optString("l"));
        }
        JSONArray list = new JSONArray();
        for (Map.Entry<String, Strategies.Pos> e : a.positions.entrySet()) {
            Strategies.Pos p = e.getValue();
            String l = labels.get(e.getKey());
            list.put(new JSONObject().put("s", e.getKey()).put("l", l == null || l.isEmpty() ? e.getKey() : l)
                    .put("q", p.qty).put("c", p.avgCost).put("m", p.mult).put("f", p.future));
        }
        return new JSONObject().put("cash", a.cash).put("start", a.start).put("positions", list).toString();
    }

    private static void notify(Context c, List<String> lines) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Paper strategies", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Target-price sales and rebalances made in the paper account");
            nm.createNotificationChannel(channel);
        }
        StringBuilder all = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) all.append('\n');
            all.append(lines.get(i));
        }
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("tab", "trading");
        PendingIntent tap = PendingIntent.getActivity(c, 8, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_screener)
                .setContentTitle(lines.size() == 1 ? "Paper strategy acted" : lines.size() + " paper strategies acted")
                .setContentText(lines.get(0))
                .setStyle(new Notification.BigTextStyle().bigText(all.toString()))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setShowWhen(true);
        nm.notify((int) (System.currentTimeMillis() / 1000L % 1_000_000_000L) + 1, b.build());
    }
}
