package com.zlhng.tradingapp;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Replays native/test/strategy-fixture.txt (written by tests/strategycross.test.ts)
 * through Strategies.java and checks every step against the TypeScript results.
 *
 *   npm run test:native
 */
public final class StrategyCrossCheck {
    private static Double num(String s) { return s.equals("-") ? null : Double.parseDouble(s); }
    private static boolean same(double a, double b) { return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)); }

    public static void main(String[] args) throws Exception {
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        int cases = 0, steps = 0, failures = 0;
        String name = "";
        Strategies.Account acct = null;
        List<Strategies.Rule> rules = null;
        Strategies.Result last = null;
        List<String> texts = new ArrayList<>();
        int textIdx = 0;
        for (String line : lines) {
            if (line.startsWith("#") || line.isEmpty()) continue;
            String[] t = line.split(" ");
            switch (t[0]) {
                case "CASE":
                    name = t[1]; acct = new Strategies.Account(); rules = new ArrayList<>(); cases++;
                    break;
                case "ACCT":
                    acct.start = num(t[1]); acct.cash = num(t[2]); acct.realized = num(t[3]);
                    break;
                case "POS":
                    acct.positions.put(t[1], new Strategies.Pos(num(t[2]), num(t[3]), num(t[4]), t[5].equals("1")));
                    break;
                case "PRULE": {
                    Strategies.Rule r = new Strategies.Rule();
                    r.id = t[1]; r.price = true; r.symbol = t[2]; r.takeProfit = num(t[3]); r.stopLoss = num(t[4]);
                    Double q = num(t[5]); r.qty = q == null ? null : q.intValue(); r.on = t[6].equals("1");
                    rules.add(r);
                    break;
                }
                case "RRULE": {
                    Strategies.Rule r = new Strategies.Rule();
                    r.id = t[1]; r.price = false; r.drift = num(t[2]); r.auto = t[3].equals("1"); r.on = t[4].equals("1");
                    for (String sw : t[5].split(",")) { String[] p = sw.split(":"); r.symbols.add(p[0]); r.weights.add(num(p[1])); }
                    rules.add(r);
                    break;
                }
                case "STEP": {
                    Map<String, Double> prices = new LinkedHashMap<>();
                    if (!t[2].equals("-")) for (String sp : t[2].split(",")) { String[] p = sp.split("="); prices.put(p[0], num(p[1])); }
                    acct.added.clear();
                    last = Strategies.run(acct, rules, prices, Long.parseLong(t[1]));
                    acct = last.account;
                    rules = last.rules;
                    texts.clear();
                    for (Strategies.Fired f : last.fired) if (f.ok) texts.add(f.text);
                    textIdx = 0;
                    steps++;
                    break;
                }
                case "WANT": {
                    List<String> errs = new ArrayList<>();
                    if (!same(acct.cash, num(t[1]))) errs.add("cash " + acct.cash + " vs " + t[1]);
                    if (!same(acct.realized, num(t[2]))) errs.add("realized " + acct.realized + " vs " + t[2]);
                    StringBuilder pos = new StringBuilder();
                    List<String> want = t[3].equals("-") ? new ArrayList<>() : java.util.Arrays.asList(t[3].split("\\|"));
                    if (want.size() != acct.positions.size()) errs.add("positions " + acct.positions.keySet() + " vs " + t[3]);
                    else {
                        int i = 0;
                        for (Map.Entry<String, Strategies.Pos> e : acct.positions.entrySet()) {
                            String[] w = want.get(i++).split(":");
                            if (!e.getKey().equals(w[0]) || !same(e.getValue().qty, num(w[1])) || !same(e.getValue().avgCost, num(w[2])))
                                errs.add("position " + e.getKey() + ":" + e.getValue().qty + ":" + e.getValue().avgCost + " vs " + String.join(":", w));
                        }
                    }
                    StringBuilder rs = new StringBuilder();
                    for (Strategies.Rule r : rules) {
                        if (rs.length() > 0) rs.append('|');
                        rs.append(r.id).append(':').append(r.on ? 1 : 0).append(':').append(!r.price && r.last != null ? Long.toString(r.last) : "-");
                    }
                    if (!rs.toString().equals(t[4])) errs.add("rules " + rs + " vs " + t[4]);
                    StringBuilder fs = new StringBuilder();
                    for (Strategies.Fired f : last.fired) { if (fs.length() > 0) fs.append('|'); fs.append(f.ruleId).append(':').append(f.ok ? 1 : 0); }
                    if (!(fs.length() == 0 ? "-" : fs.toString()).equals(t[5])) errs.add("fired " + fs + " vs " + t[5]);
                    if (!errs.isEmpty()) { failures++; System.out.println("case " + name + " step " + steps + ": " + String.join("; ", errs)); }
                    break;
                }
                case "TEXT": {
                    String want = line.substring(5);
                    String got = textIdx < texts.size() ? texts.get(textIdx) : "(none)";
                    textIdx++;
                    if (!want.equals(got)) { failures++; System.out.println("case " + name + " text: " + got + " vs " + want); }
                    break;
                }
                default:
                    break;
            }
        }
        System.out.println("Strategy cross-check: " + cases + " cases, " + steps + " steps, " + failures + " mismatches");
        if (failures > 0 || cases == 0) System.exit(1);
    }
}
