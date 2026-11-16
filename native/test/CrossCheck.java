package com.zlhng.tradingapp;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Checks Screens.java against the TypeScript rules. fixture.txt is written by the
 * TypeScript test suite (tests/crosscheck.test.ts): for each case it lists the price
 * series to generate, the filters, and the alert keys the TypeScript code produced.
 * This program regenerates the same prices, runs the Java rules and compares.
 *
 *   npm run test:native
 */
public final class CrossCheck {
    /** Same generator as series() in tests/crosscheck.test.ts: whole-number cents, so both languages agree exactly. */
    static double[] series(int seed, int kind, int len) {
        int[] s = {seed};
        int[] drifts = {0, 60, -60, 120, 0};
        int p = 2000 + next(s) % 30000;
        int vol = 600 + next(s) % 1400;
        double[] out = new double[len];
        for (int i = 0; i < len; i++) {
            int change = drifts[kind] + ((next(s) % 2001) - 1000) * vol / 1000;
            if (kind == 1 && i >= len - 3) change -= 2500;
            if (kind == 2 && i >= len - 3) change += 2500;
            p = Math.max(100, p + (int) ((long) p * change / 100000));
            out[i] = p / 100.0;
        }
        return out;
    }

    private static int next(int[] s) {
        s[0] = s[0] * 1664525 + 1013904223;
        return (s[0] >>> 8) & 0xffff;
    }

    private static List<String> csv(String v) {
        return v.isEmpty() ? new ArrayList<>() : Arrays.asList(v.split(","));
    }

    public static void main(String[] args) throws Exception {
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        int cases = 0;
        int failed = 0;
        int keys = 0;
        String name = "";
        Map<String, double[]> data = new HashMap<>();
        Map<String, List<String>> lists = new HashMap<>();
        Screens.Params p = new Screens.Params();
        TreeSet<String> expected = new TreeSet<>();
        for (String line : lines) {
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] t = line.split(" ", 3);
            switch (t[0]) {
                case "CASE":
                    name = line.substring(5);
                    data = new HashMap<>();
                    lists = new HashMap<>();
                    p = new Screens.Params();
                    expected = new TreeSet<>();
                    break;
                case "SYM": {
                    String[] f = line.split(" ");
                    data.put(f[1], series(Integer.parseInt(f[2]), Integer.parseInt(f[3]), Integer.parseInt(f[4])));
                    break;
                }
                case "LIST":
                    lists.put(t[1], csv(t.length > 2 ? t[2] : ""));
                    break;
                case "PARAM": {
                    String v = t.length > 2 ? t[2] : "";
                    switch (t[1]) {
                        case "macroTrend": p.macroTrend = v; break;
                        case "fast": p.fast = Integer.parseInt(v); break;
                        case "slow": p.slow = Integer.parseInt(v); break;
                        case "z": p.z = Double.parseDouble(v); break;
                        case "rsiLow": p.rsiLow = Double.parseDouble(v); break;
                        case "rsiHigh": p.rsiHigh = Double.parseDouble(v); break;
                        case "mom": p.mom = Double.parseDouble(v); break;
                        case "signals": p.signals = new HashSet<>(csv(v)); break;
                        case "checks": {
                            List<String> c = csv(v);
                            for (int i = 0; i < 8; i++) p.checks[i] = c.get(i).equals("1");
                            break;
                        }
                        case "lowPct": p.lowPct = Double.parseDouble(v); break;
                        case "highPct": p.highPct = Double.parseDouble(v); break;
                        case "rsMin": p.rsMin = Integer.parseInt(v); break;
                        case "enterN": p.enterN = Integer.parseInt(v); break;
                        case "exitN": p.exitN = Integer.parseInt(v); break;
                        case "pos": p.pos = v; break;
                        default: throw new IllegalStateException("Unknown PARAM " + t[1]);
                    }
                    break;
                }
                case "EXPECT":
                    expected.add(t[1]);
                    break;
                case "END": {
                    cases++;
                    TreeSet<String> got = new TreeSet<>();
                    for (Screens.Item it : Screens.evaluate(data, lists.get("macro"), lists.get("quant"), lists.get("stocks"), lists.get("futures"), p)) got.add(it.key());
                    keys += expected.size();
                    if (!got.equals(expected)) {
                        failed++;
                        TreeSet<String> missing = new TreeSet<>(expected);
                        missing.removeAll(got);
                        TreeSet<String> extra = new TreeSet<>(got);
                        extra.removeAll(expected);
                        System.out.println("MISMATCH in case \"" + name + "\"\n  only in TypeScript: " + missing + "\n  only in Java: " + extra);
                    }
                    break;
                }
                default:
                    throw new IllegalStateException("Unknown line: " + line);
            }
        }
        if (cases == 0) throw new IllegalStateException("No cases in " + args[0]);
        System.out.println(cases + " cases, " + keys + " expected alert keys, " + failed + " mismatched");
        if (failed > 0) System.exit(1);
    }
}
