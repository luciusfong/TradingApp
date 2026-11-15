package com.zlhng.tradingapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.Html;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Data for the home-screen widgets. The watchlist and paper account are written by the
 * web app through Capacitor Preferences; quotes and headlines are fetched here so the
 * widgets stay current while the app is closed.
 */
final class WidgetData {
    private static final String PREFS = "ta_widget";
    private static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
    private static final Object LOCK = new Object();
    private static final long FRESH_MS = 5 * 60_000L;
    private static final Pattern ITEM = Pattern.compile("<item>(.*?)</item>", Pattern.DOTALL);
    private static final Pattern LOW_VALUE = Pattern.compile(
            "stocks? to (buy|sell|watch|avoid)|should you (buy|sell)|here'?s (why|what|how)|what to know|motley fool|\\b\\d+ (best|top)\\b|millionaire|better buy",
            Pattern.CASE_INSENSITIVE);

    private WidgetData() {}

    private static String appValue(Context c, String key) {
        return c.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString(key, null);
    }

    /** Watchlist saved by the app: [{s: symbol, l: label, n: name}], or null if the app has not saved one yet. */
    static JSONArray watchlist(Context c) {
        try {
            String raw = appValue(c, "widget.watchlist");
            return raw == null ? null : new JSONArray(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** Paper account saved by the app: {cash, start, positions: [{s, l, q: quantity, c: average cost}]}. */
    static JSONObject paper(Context c) {
        try {
            String raw = appValue(c, "widget.paper");
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** Last fetched data: {quotes: {symbol: {p: price, c: change %}}, news: [{t, s, u, at}]}. */
    static JSONObject cache(Context c) {
        try {
            String raw = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null);
            return raw == null ? new JSONObject() : new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static long updatedAt(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("at", 0);
    }

    private static void collect(JSONArray list, Set<String> out) {
        if (list == null) return;
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            String s = o == null ? "" : o.optString("s", "");
            if (!s.isEmpty()) out.add(s);
        }
    }

    /** Fetches quotes and headlines. Runs on a background thread; keeps the old data if offline. */
    static void refresh(Context c, boolean force) {
        synchronized (LOCK) {
            SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!force && System.currentTimeMillis() - sp.getLong("at", 0) < FRESH_MS) return;

            Set<String> symbols = new LinkedHashSet<>();
            collect(watchlist(c), symbols);
            JSONObject paper = paper(c);
            if (paper != null) collect(paper.optJSONArray("positions"), symbols);

            ExecutorService pool = Executors.newFixedThreadPool(6);
            Map<String, Future<JSONObject>> quoteJobs = new LinkedHashMap<>();
            for (final String s : symbols) {
                Callable<JSONObject> job = () -> quote(s);
                quoteJobs.put(s, pool.submit(job));
            }
            Callable<JSONArray> newsCall = WidgetData::news;
            Future<JSONArray> newsJob = pool.submit(newsCall);
            pool.shutdown();
            try {
                pool.awaitTermination(8, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }

            try {
                JSONObject data = cache(c);
                JSONObject quotes = data.optJSONObject("quotes");
                if (quotes == null) quotes = new JSONObject();
                boolean any = false;
                for (Map.Entry<String, Future<JSONObject>> e : quoteJobs.entrySet()) {
                    JSONObject q = done(e.getValue());
                    if (q != null) {
                        quotes.put(e.getKey(), q);
                        any = true;
                    }
                }
                JSONArray news = done(newsJob);
                if (news != null && news.length() > 0) {
                    data.put("news", news);
                    any = true;
                }
                data.put("quotes", quotes);
                if (any) sp.edit().putString("data", data.toString()).putLong("at", System.currentTimeMillis()).apply();
            } catch (Exception ignored) {
                // keep the previous data
            } finally {
                pool.shutdownNow();
            }
        }
    }

    private static <T> T done(Future<T> f) {
        try {
            return f.isDone() ? f.get() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String get(String url) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(5000);
        h.setReadTimeout(6000);
        h.setRequestProperty("User-Agent", UA);
        h.setRequestProperty("Accept", "*/*");
        try {
            if (h.getResponseCode() != 200) throw new Exception("HTTP " + h.getResponseCode());
            try (InputStream in = h.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            h.disconnect();
        }
    }

    private static JSONObject quote(String symbol) throws Exception {
        String url = "https://query1.finance.yahoo.com/v8/finance/chart/" + URLEncoder.encode(symbol, "UTF-8")
                + "?range=1d&interval=5m&includePrePost=false";
        JSONObject meta = new JSONObject(get(url)).getJSONObject("chart").getJSONArray("result").getJSONObject(0).getJSONObject("meta");
        double price = meta.getDouble("regularMarketPrice");
        double prev = meta.optDouble("chartPreviousClose", meta.optDouble("previousClose", price));
        JSONObject q = new JSONObject();
        q.put("p", price);
        q.put("c", prev > 0 ? (price - prev) / prev * 100 : 0);
        return q;
    }

    private static String tag(String block, String name) {
        Matcher m = Pattern.compile("<" + name + "(?:\\s[^>]*)?>(.*?)</" + name + ">", Pattern.DOTALL).matcher(block);
        if (!m.find()) return "";
        String v = m.group(1).trim();
        if (v.startsWith("<![CDATA[") && v.endsWith("]]>")) v = v.substring(9, v.length() - 3);
        return v;
    }

    private static String text(String s) {
        return Html.fromHtml(s, Html.FROM_HTML_MODE_LEGACY).toString().replaceAll("\\s+", " ").trim();
    }

    private static JSONArray news() throws Exception {
        String url = "https://news.google.com/rss/search?q=" + URLEncoder.encode("stock market when:1d", "UTF-8") + "&hl=en-US&gl=US&ceid=US:en";
        String xml = get(url);
        SimpleDateFormat fmt = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
        List<JSONObject> items = new ArrayList<>();
        Matcher m = ITEM.matcher(xml);
        while (m.find() && items.size() < 60) {
            String block = m.group(1);
            String title = text(tag(block, "title"));
            String source = text(tag(block, "source"));
            String link = text(tag(block, "link"));
            if (title.isEmpty() || !link.startsWith("http")) continue;
            // Google News titles end with " - Publisher"
            if (!source.isEmpty() && title.endsWith(" - " + source)) title = title.substring(0, title.length() - source.length() - 3);
            if (LOW_VALUE.matcher(title).find() || LOW_VALUE.matcher(source).find()) continue;
            long at;
            try {
                Date d = fmt.parse(tag(block, "pubDate"));
                at = d == null ? System.currentTimeMillis() : d.getTime();
            } catch (Exception e) {
                at = System.currentTimeMillis();
            }
            JSONObject o = new JSONObject();
            o.put("t", title);
            o.put("s", source);
            o.put("u", link);
            o.put("at", at);
            items.add(o);
        }
        items.sort((a, b) -> Long.compare(b.optLong("at"), a.optLong("at")));
        JSONArray out = new JSONArray();
        for (int i = 0; i < items.size() && i < 12; i++) out.put(items.get(i));
        return out;
    }
}
