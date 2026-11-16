package com.zlhng.tradingapp;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Screener's rules in plain Java, for the background alert job. This mirrors
 * src/lib/screen.ts and src/lib/alerts.ts line for line, including the order of the
 * arithmetic, so both give the same answer on the same prices. native/test/CrossCheck.java
 * runs both against native/test/fixture.txt; change one side and that check fails until
 * the other is changed too. No Android classes here, so it compiles and runs anywhere.
 */
final class Screens {
    private Screens() {}

    /** The adjustable filters, with the same defaults as DEFAULT_FILTERS in src/lib/filters.ts. */
    static final class Params {
        String macroTrend = "any";
        int fast = 50, slow = 200;
        double z = 2, rsiLow = 5, rsiHigh = 95, mom = 20;
        Set<String> signals = new HashSet<>(Arrays.asList("dip-uptrend", "spike-downtrend", "stretched-down", "stretched-up", "momentum"));
        boolean[] checks = {true, true, true, true, true, true, true, true};
        double lowPct = 30, highPct = 25;
        int rsMin = 70, enterN = 55, exitN = 20;
        String pos = "any";
    }

    /** One symbol that matches a tab's filters and is in an active state. */
    static final class Item {
        final String tab, symbol, state;

        Item(String tab, String symbol, String state) {
            this.tab = tab;
            this.symbol = symbol;
            this.state = state;
        }

        String key() {
            return tab + ":" + symbol + ":" + state;
        }
    }

    // NaN stands in for the "null" (not enough data) of the TypeScript version;
    // every comparison with NaN is false, which is what the null checks there do.
    private static final double NONE = Double.NaN;

    static double last(double[] a) {
        return a[a.length - 1];
    }

    /** Mean of the n values ending just before index end. */
    private static double smaAt(double[] a, int end, int n) {
        if (end < n) return NONE;
        double s = 0;
        for (int i = end - n; i < end; i++) s += a[i];
        return s / n;
    }

    static double sma(double[] a, int n) {
        return smaAt(a, a.length, n);
    }

    private static double stdev(double[] a, int from, int to) {
        int n = to - from;
        if (n < 2) return 0;
        double sum = 0;
        for (int i = from; i < to; i++) sum += a[i];
        double m = sum / n;
        double acc = 0;
        for (int i = from; i < to; i++) acc += (a[i] - m) * (a[i] - m);
        return Math.sqrt(acc / (n - 1));
    }

    static double ret(double[] a, int n, int skip) {
        int end = a.length - 1 - skip;
        int start = end - n;
        if (start < 0 || a[start] == 0 || Double.isNaN(a[start])) return NONE;
        return (a[end] / a[start] - 1) * 100;
    }

    static double zscore(double[] a, int n) {
        if (a.length < n) return NONE;
        double sd = stdev(a, a.length - n, a.length);
        if (sd == 0 || Double.isNaN(sd)) return 0;
        double sum = 0;
        for (int i = a.length - n; i < a.length; i++) sum += a[i];
        return (last(a) - sum / n) / sd;
    }

    static double rsi(double[] a, int n) {
        if (a.length < n + 1) return NONE;
        double up = 0;
        double dn = 0;
        for (int i = 1; i <= n; i++) {
            double d = a[i] - a[i - 1];
            if (d >= 0) up += d; else dn -= d;
        }
        up /= n;
        dn /= n;
        for (int i = n + 1; i < a.length; i++) {
            double d = a[i] - a[i - 1];
            up = (up * (n - 1) + Math.max(d, 0)) / n;
            dn = (dn * (n - 1) + Math.max(-d, 0)) / n;
        }
        if (dn == 0) return up == 0 ? 50 : 100;
        return 100 - 100 / (1 + up / dn);
    }

    static String trendOf(double[] a, int fast, int slow) {
        double p = last(a);
        double mFast = sma(a, fast);
        double mSlow = sma(a, Math.min(slow, a.length));
        if (Double.isNaN(mFast) || Double.isNaN(mSlow)) return "mixed";
        if (p > mFast && mFast > mSlow) return "up";
        if (p < mFast && mFast < mSlow) return "down";
        return "mixed";
    }

    static String quantSignal(double[] a, Params p) {
        double z = zscore(a, 20);
        double r2 = rsi(a, 2);
        double mom = ret(a, 105, 21);
        double m200 = sma(a, Math.min(200, a.length));
        Boolean above200 = a.length >= 120 && !Double.isNaN(m200) && m200 != 0 ? Boolean.valueOf(last(a) > m200) : null;
        boolean low = z <= -p.z || r2 <= p.rsiLow;
        boolean high = z >= p.z || r2 >= p.rsiHigh;
        if (low && Boolean.TRUE.equals(above200)) return "dip-uptrend";
        if (high && Boolean.FALSE.equals(above200)) return "spike-downtrend";
        if (z <= -p.z) return "stretched-down";
        if (z >= p.z) return "stretched-up";
        if (mom >= p.mom && Boolean.TRUE.equals(above200) && Math.abs(z) < 1.5) return "momentum";
        return "none";
    }

    private static final class Template {
        String symbol;
        boolean[] checks;
        double rsRaw;
    }

    private static double nz(double v) {
        return Double.isNaN(v) ? 0 : v;
    }

    private static Template template(String symbol, double[] a, Params tp) {
        if (a.length < 222) return null;
        double p = last(a);
        double m50 = sma(a, 50);
        double m150 = sma(a, 150);
        double m200 = sma(a, 200);
        double m200Prev = smaAt(a, a.length - 21, 200);
        double hi = a[0];
        double lo = a[0];
        for (double v : a) {
            if (v > hi) hi = v;
            if (v < lo) lo = v;
        }
        Template t = new Template();
        t.symbol = symbol;
        t.checks = new boolean[] {
            p > m150 && p > m200,
            m150 > m200,
            m200 > m200Prev,
            m50 > m150 && m50 > m200,
            p > m50,
            p >= lo * (1 + tp.lowPct / 100),
            p >= hi * (1 - tp.highPct / 100),
        };
        double q0 = nz(ret(a, 63, 0));
        double q1 = nz(ret(a, 63, 63));
        double q2 = nz(ret(a, 63, 126));
        double q3 = nz(ret(a, Math.min(63, a.length - 190), 189));
        t.rsRaw = 0.4 * q0 + 0.2 * q1 + 0.2 * q2 + 0.2 * q3;
        return t;
    }

    /** Symbols that pass every required check; relative strength only counts with 8 or more names. */
    private static List<String> templatePasses(List<Template> rows, Params p) {
        int n = rows.size();
        boolean ranked = n >= 8;
        List<Template> sorted = new ArrayList<>(rows);
        if (ranked) sorted.sort((x, y) -> x.rsRaw < y.rsRaw ? -1 : x.rsRaw > y.rsRaw ? 1 : 0);
        List<String> out = new ArrayList<>();
        for (Template t : rows) {
            boolean ok = true;
            for (int i = 0; i < 7; i++) if (p.checks[i] && !t.checks[i]) ok = false;
            if (ranked && p.checks[7]) {
                long rs = Math.max(1, Math.min(99, Math.round((sorted.indexOf(t) / (double) (n - 1)) * 98 + 1)));
                if (rs < p.rsMin) ok = false;
            }
            if (ok) out.add(t.symbol);
        }
        return out;
    }

    private static double hiOf(double[] a, int i, int n) {
        double m = Double.NEGATIVE_INFINITY;
        for (int k = i - n; k < i; k++) if (a[k] > m) m = a[k];
        return m;
    }

    private static double loOf(double[] a, int i, int n) {
        double m = Double.POSITIVE_INFINITY;
        for (int k = i - n; k < i; k++) if (a[k] < m) m = a[k];
        return m;
    }

    /** 1 long, -1 short, 0 flat; 2 when there is not enough history. */
    static int turtlePos(double[] a, int enterN, int exitDays) {
        if (a.length < Math.max(enterN + 2, 21)) return 2;
        int exitN = Math.min(exitDays, enterN);
        int pos = 0;
        for (int i = enterN; i < a.length; i++) {
            double c = a[i];
            if (pos == 1 && c < loOf(a, i, exitN)) pos = 0;
            else if (pos == -1 && c > hiOf(a, i, exitN)) pos = 0;
            if (pos == 0) {
                if (c > hiOf(a, i, enterN)) pos = 1;
                else if (c < loOf(a, i, enterN)) pos = -1;
            }
        }
        return pos;
    }

    static List<Item> evaluate(Map<String, double[]> data, List<String> macro, List<String> quant, List<String> stocks, List<String> futures, Params p) {
        List<Item> out = new ArrayList<>();
        for (String s : macro) {
            double[] a = data.get(s);
            if (a == null || a.length <= 60) continue;
            String trend = trendOf(a, p.fast, p.slow);
            if (!trend.equals("mixed") && (p.macroTrend.equals("any") || p.macroTrend.equals(trend))) out.add(new Item("macro", s, trend));
        }
        for (String s : quant) {
            double[] a = data.get(s);
            if (a == null || a.length <= 25) continue;
            String signal = quantSignal(a, p);
            if (!signal.equals("none") && p.signals.contains(signal)) out.add(new Item("quant", s, signal));
        }
        List<Template> rows = new ArrayList<>();
        for (String s : stocks) {
            double[] a = data.get(s);
            Template t = a == null ? null : template(s, a, p);
            if (t != null) rows.add(t);
        }
        for (String s : templatePasses(rows, p)) out.add(new Item("tech", s, "pass"));
        for (String s : futures) {
            double[] a = data.get(s);
            if (a == null) continue;
            int pos = turtlePos(a, p.enterN, p.exitN);
            if (pos != 1 && pos != -1) continue;
            boolean show = p.pos.equals("long") ? pos == 1 : p.pos.equals("short") ? pos == -1 : true;
            if (show) out.add(new Item("turtle", s, pos == 1 ? "long" : "short"));
        }
        return out;
    }
}
