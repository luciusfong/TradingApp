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

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * The background check behind Screener alerts. It downloads a year of daily prices
 * for the symbols the Screener covers, runs the same rules as the app (Screens.java)
 * with the user's filters, and posts a notification for matches that were not there
 * on the previous run. The symbols and filters are written by the app into Capacitor
 * Preferences under "alerts.config" (alertConfig() in src/lib/native.ts).
 */
final class ScreenerCheck {
    private static final String PREFS = "ta_alerts";
    private static final String CHANNEL = "screener";
    private static final long HOUR = 60 * 60 * 1000L;
    private static final long QUIET_MS = 20 * HOUR; // the same match is not announced twice within this time
    private static final Object LOCK = new Object();

    private ScreenerCheck() {}

    private static String rawConfig(Context c) {
        return c.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("alerts.config", null);
    }

    private static JSONObject parse(String raw) {
        try {
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean enabled(Context c) {
        JSONObject cfg = parse(rawConfig(c));
        return cfg != null && cfg.optBoolean("on", false);
    }

    private static String signature(String raw) {
        return raw.length() + ":" + raw.hashCode();
    }

    /** True when the symbols or filters changed since the last run, so "new" has to be measured afresh. */
    static boolean needsBaseline(Context c) {
        String raw = rawConfig(c);
        return raw != null && !signature(raw).equals(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("sig", ""));
    }

    /** Alerts were switched off: forget what was matched, so switching back on starts clean. */
    static void forget(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private static List<String> list(JSONObject cfg, String key) {
        List<String> out = new ArrayList<>();
        JSONArray a = cfg.optJSONArray(key);
        for (int i = 0; a != null && i < a.length(); i++) {
            String s = a.optString(i, "");
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    static Screens.Params params(JSONObject f) {
        Screens.Params p = new Screens.Params();
        if (f == null) return p;
        JSONObject m = f.optJSONObject("macro");
        if (m != null) {
            p.macroTrend = m.optString("trend", p.macroTrend);
            p.fast = m.optInt("fast", p.fast);
            p.slow = m.optInt("slow", p.slow);
        }
        JSONObject q = f.optJSONObject("quant");
        if (q != null) {
            p.z = q.optDouble("z", p.z);
            p.rsiLow = q.optDouble("rsiLow", p.rsiLow);
            p.rsiHigh = q.optDouble("rsiHigh", p.rsiHigh);
            p.mom = q.optDouble("mom", p.mom);
            JSONArray s = q.optJSONArray("signals");
            if (s != null) {
                p.signals = new HashSet<>();
                for (int i = 0; i < s.length(); i++) p.signals.add(s.optString(i));
            }
        }
        JSONObject t = f.optJSONObject("tech");
        if (t != null) {
            JSONArray checks = t.optJSONArray("checks");
            for (int i = 0; checks != null && i < 8 && i < checks.length(); i++) p.checks[i] = checks.optBoolean(i, true);
            p.lowPct = t.optDouble("lowPct", p.lowPct);
            p.highPct = t.optDouble("highPct", p.highPct);
            p.rsMin = t.optInt("rsMin", p.rsMin);
            p.enterN = t.optInt("enterN", p.enterN);
            p.exitN = t.optInt("exitN", p.exitN);
            p.pos = t.optString("pos", p.pos);
        }
        return p;
    }

    /** No US stock or futures market trades from Friday evening to Sunday evening, New York time. */
    private static boolean marketsTrading() {
        Calendar ny = Calendar.getInstance(TimeZone.getTimeZone("America/New_York"));
        int day = ny.get(Calendar.DAY_OF_WEEK);
        int hour = ny.get(Calendar.HOUR_OF_DAY);
        if (day == Calendar.SATURDAY) return false;
        if (day == Calendar.SUNDAY) return hour >= 18;
        if (day == Calendar.FRIDAY) return hour < 18;
        return true;
    }

    /** One year of daily closes, the same request the Screener makes in the app. */
    private static double[] closes(String symbol) throws Exception {
        String url = "https://query1.finance.yahoo.com/v8/finance/chart/" + URLEncoder.encode(symbol, "UTF-8")
                + "?range=1y&interval=1d&includePrePost=false";
        JSONArray close = new JSONObject(WidgetData.get(url)).getJSONObject("chart").getJSONArray("result").getJSONObject(0)
                .getJSONObject("indicators").getJSONArray("quote").getJSONObject(0).getJSONArray("close");
        double[] tmp = new double[close.length()];
        int n = 0;
        for (int i = 0; i < close.length(); i++) {
            if (close.isNull(i)) continue;
            double v = close.optDouble(i, Double.NaN);
            if (!Double.isNaN(v) && !Double.isInfinite(v)) tmp[n++] = v;
        }
        return Arrays.copyOf(tmp, n);
    }

    private static Map<String, double[]> fetch(Set<String> symbols) {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        Map<String, Future<double[]>> jobs = new LinkedHashMap<>();
        for (final String s : symbols) {
            Callable<double[]> job = () -> closes(s);
            jobs.put(s, pool.submit(job));
        }
        pool.shutdown();
        try {
            pool.awaitTermination(120, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        Map<String, double[]> out = new HashMap<>();
        for (Map.Entry<String, Future<double[]>> e : jobs.entrySet()) {
            try {
                double[] a = e.getValue().isDone() ? e.getValue().get() : null;
                if (a != null && a.length > 1) out.put(e.getKey(), a);
            } catch (Exception ignored) {
                // this symbol is skipped for this run
            }
        }
        pool.shutdownNow();
        return out;
    }

    static void run(Context c) {
        synchronized (LOCK) {
            try {
                check(c);
            } catch (Exception ignored) {
                // a failed run changes nothing; the next one starts from the same state
            }
        }
    }

    private static void check(Context c) throws Exception {
        String raw = rawConfig(c);
        JSONObject cfg = parse(raw);
        if (cfg == null || !cfg.optBoolean("on", false)) return;
        SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sig = signature(raw);
        // After the symbols or filters change, the first run only records what matches; nothing is announced.
        boolean baseline = !sig.equals(sp.getString("sig", ""));
        if (!baseline && !marketsTrading()) return;

        List<String> macro = list(cfg, "macro");
        List<String> quant = list(cfg, "quant");
        List<String> stocks = list(cfg, "stocks");
        List<String> futures = list(cfg, "futures");
        Set<String> symbols = new LinkedHashSet<>();
        symbols.addAll(macro);
        symbols.addAll(quant);
        symbols.addAll(stocks);
        symbols.addAll(futures);
        Map<String, double[]> data = fetch(symbols);
        if (data.isEmpty()) return; // offline: try again next time

        Screens.Params p = params(cfg.optJSONObject("f"));
        List<Screens.Item> items = Screens.evaluate(data, macro, quant, stocks, futures, p);

        Set<String> prev = new HashSet<>(sp.getStringSet("keys", new HashSet<String>()));
        Set<String> now = new HashSet<>();
        for (Screens.Item it : items) now.add(it.key());
        // A symbol whose prices failed to load keeps its earlier matches, so it is not announced again when it comes back.
        for (String k : prev) {
            String[] parts = k.split(":");
            if (parts.length == 3 && symbols.contains(parts[1]) && !data.containsKey(parts[1])) now.add(k);
        }

        long t = System.currentTimeMillis();
        JSONObject told = parse(sp.getString("told", null));
        if (told == null) told = new JSONObject();
        List<Screens.Item> fresh = new ArrayList<>();
        if (!baseline) {
            for (Screens.Item it : items) {
                String k = it.key();
                if (prev.contains(k) || t - told.optLong(k, 0) < QUIET_MS) continue;
                fresh.add(it);
                told.put(k, t);
            }
        }
        JSONObject kept = new JSONObject();
        for (Iterator<String> names = told.keys(); names.hasNext();) {
            String k = names.next();
            if (t - told.optLong(k, 0) < 7 * 24 * HOUR) kept.put(k, told.optLong(k, 0));
        }

        // A baseline taken while some prices failed to load is retried, up to three times, before it is accepted.
        int tries = baseline ? sp.getInt("tries", 0) + 1 : 0;
        boolean accept = !baseline || data.size() == symbols.size() || tries >= 3;
        sp.edit().putStringSet("keys", now).putString("told", kept.toString()).putLong("at", t)
                .putString("sig", accept ? sig : sp.getString("sig", "")).putInt("tries", accept ? 0 : tries).apply();
        if (!fresh.isEmpty()) post(c, fresh, cfg.optJSONObject("labels"), p);
    }

    private static String signalText(String signal) {
        switch (signal) {
            case "dip-uptrend": return "dip in an uptrend";
            case "spike-downtrend": return "spike in a downtrend";
            case "stretched-down": return "stretched down";
            case "stretched-up": return "stretched up";
            case "momentum": return "steady momentum";
            default: return signal;
        }
    }

    private static String describe(Screens.Item it, String label, Screens.Params p) {
        switch (it.tab) {
            case "macro": return label + ": now in " + (it.state.equals("up") ? "an uptrend" : "a downtrend") + " (Macro)";
            case "quant": return label + ": " + signalText(it.state) + " (Quant)";
            case "tech": return label + ": passes the trend template (Technical)";
            default: return label + ": " + p.enterN + "-day breakout, " + it.state + " (Technical)";
        }
    }

    private static void post(Context c, List<Screens.Item> fresh, JSONObject labels, Screens.Params p) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Screener matches", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("New matches for your Screener filters");
            nm.createNotificationChannel(channel);
        }
        List<String> lines = new ArrayList<>();
        for (Screens.Item it : fresh) lines.add(describe(it, labels == null ? it.symbol : labels.optString(it.symbol, it.symbol), p));
        String title = lines.size() == 1 ? "New screener match" : lines.size() + " new screener matches";
        String first = lines.size() == 1 ? lines.get(0) : lines.get(0) + ", and " + (lines.size() - 1) + " more";
        StringBuilder all = new StringBuilder();
        for (int i = 0; i < lines.size() && i < 12; i++) {
            if (i > 0) all.append('\n');
            all.append(lines.get(i));
        }
        if (lines.size() > 12) all.append("\nand ").append(lines.size() - 12).append(" more");

        // Opens the app on the Screener tab (MainActivity passes the tab name on to the web app).
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("tab", "screener");
        PendingIntent tap = PendingIntent.getActivity(c, 7, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_screener)
                .setContentTitle(title)
                .setContentText(first)
                .setStyle(new Notification.BigTextStyle().bigText(all.toString()))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setShowWhen(true);
        nm.notify((int) (System.currentTimeMillis() / 1000L % 1_000_000_000L), b.build());
    }
}
