package com.zlhng.tradingapp;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The paper strategies (sell at a target price, rebalance) in Java, so the background
 * job can run them while the app is closed. Plain Java with no Android classes.
 *
 * It must match src/lib/paper.ts (applyOrder, breakdown) and src/lib/strategy.ts
 * (priceOrder, rebalancePlan, runRules) operation for operation, so both give the same
 * fills to the cent. native/test/StrategyCrossCheck.java checks that against cases
 * written by tests/strategycross.test.ts (npm run test:native).
 */
final class Strategies {
    private Strategies() {}

    static final double MARGIN_LONG = 1, MARGIN_SHORT = 0.5, MARGIN_FUTURE = 0.1;

    static final class Pos {
        double qty, avgCost, mult = 1;
        boolean future;
        Pos(double qty, double avgCost, double mult, boolean future) { this.qty = qty; this.avgCost = avgCost; this.mult = mult; this.future = future; }
    }

    static final class Trade {
        String symbol, side;
        double qty, price;
        long time;
        Double pnl;
    }

    static final class Account {
        double start, cash, realized;
        LinkedHashMap<String, Pos> positions = new LinkedHashMap<>();
        List<Trade> added = new ArrayList<>(); // trades made by this run, newest first

        Account copy() {
            Account a = new Account();
            a.start = start; a.cash = cash; a.realized = realized;
            for (Map.Entry<String, Pos> e : positions.entrySet()) {
                Pos p = e.getValue();
                a.positions.put(e.getKey(), new Pos(p.qty, p.avgCost, p.mult, p.future));
            }
            a.added = new ArrayList<>(added);
            return a;
        }
    }

    static final class Rule {
        String id;
        boolean price; // true: target price; false: rebalance
        boolean on;
        // target price
        String symbol;
        Double takeProfit, stopLoss;
        Integer qty;
        // rebalance
        List<String> symbols = new ArrayList<>();
        List<Double> weights = new ArrayList<>();
        double drift;
        boolean auto;
        Long last;
    }

    static final class Fired {
        String ruleId, text;
        boolean ok;
        long time;
    }

    static final class Result {
        Account account;
        List<Rule> rules;
        List<Fired> fired = new ArrayList<>();
    }

    // ---------- Helpers matching JavaScript ----------

    static double cents(double v) { return Math.round(v * 100) / 100.0; }

    /** Number.prototype.toFixed: rounds the exact binary value half up. */
    static String toFixed(double v, int digits) {
        return new BigDecimal(v).setScale(digits, RoundingMode.HALF_UP).toPlainString();
    }

    /** String(number) for the plain prices a user types. */
    static String jsNum(double v) {
        if (v == Math.rint(v) && Math.abs(v) < 1e15) return Long.toString((long) v);
        return BigDecimal.valueOf(v).stripTrailingZeros().toPlainString();
    }

    private static Double priced(Map<String, Double> prices, String s) {
        Double p = prices.get(s);
        return p != null && p > 0 ? p : null;
    }

    // ---------- breakdown() ----------

    static final class Totals { double equity, required, buyingPower; }

    static Totals totals(Account a, Map<String, Double> prices) {
        double equity = a.cash;
        double required = 0;
        for (Map.Entry<String, Pos> e : a.positions.entrySet()) {
            Pos p = e.getValue();
            Double live = priced(prices, e.getKey());
            double price = live != null ? live : p.avgCost;
            boolean shortPos = p.qty < 0;
            double exposure = Math.abs(p.qty) * price * p.mult;
            double pnl = (price - p.avgCost) * p.qty * p.mult;
            equity += p.future ? pnl : p.qty * price;
            required += exposure * (p.future ? MARGIN_FUTURE : shortPos ? MARGIN_SHORT : MARGIN_LONG);
        }
        Totals t = new Totals();
        t.equity = equity;
        t.required = required;
        t.buyingPower = equity - required;
        return t;
    }

    // ---------- applyOrder() ----------

    static Account applyOrder(Account a, String symbol, boolean buy, int qty, double price, long time, Map<String, Double> prices) {
        if (qty <= 0) throw new IllegalArgumentException("Quantity must be a whole number of shares, 1 or more.");
        if (!(price > 0)) throw new IllegalArgumentException("No price available for this symbol.");
        Pos held = a.positions.get(symbol);
        double mult = held != null ? held.mult : 1;
        boolean future = held != null && held.future;
        double old = held == null ? 0 : held.qty;
        double delta = buy ? qty : -qty;
        double nq = old + delta;
        Account next = a.copy();
        Trade trade = new Trade();
        trade.symbol = symbol; trade.side = buy ? "buy" : "sell"; trade.qty = qty; trade.price = price; trade.time = time;
        double cash = a.cash;
        double realized = a.realized;
        double avgCost = price;

        if (old != 0 && Math.signum(old) != Math.signum(delta)) {
            double closed = Math.min(Math.abs(old), Math.abs(delta));
            trade.pnl = cents((price - held.avgCost) * closed * Math.signum(old) * mult);
            realized = cents(realized + trade.pnl);
            if (future) cash = cents(cash + trade.pnl);
            if (Math.abs(delta) <= Math.abs(old)) avgCost = held.avgCost;
        } else if (old != 0) {
            avgCost = (Math.abs(old) * held.avgCost + Math.abs(delta) * price) / Math.abs(nq);
        }
        if (!future) cash = cents(cash - delta * price);
        if (nq == 0) next.positions.remove(symbol);
        else next.positions.put(symbol, new Pos(nq, avgCost, mult, future));
        next.cash = cash;
        next.realized = realized;
        next.added.add(0, trade);

        Map<String, Double> marks = new LinkedHashMap<>(prices);
        marks.put(symbol, price);
        Totals before = totals(a, marks);
        Totals after = totals(next, marks);
        if (after.required > before.required + 0.005 && after.buyingPower < -0.005) {
            throw new IllegalStateException("Not enough buying power. This order needs $" + toFixed(after.required - before.required, 2)
                    + " of margin and you have $" + toFixed(Math.max(0, before.buyingPower), 2) + " available.");
        }
        return next;
    }

    // ---------- priceOrder() ----------

    static final class Hit { int qty; double price; String why; }

    static Hit priceOrder(Rule r, Account a, Double price) {
        Pos held = a.positions.get(r.symbol);
        if (!r.on || held == null || held.qty <= 0 || held.future || price == null || !(price > 0)) return null;
        boolean hitTp = r.takeProfit != null && price >= r.takeProfit;
        boolean hitSl = r.stopLoss != null && price <= r.stopLoss;
        if (!hitTp && !hitSl) return null;
        Hit h = new Hit();
        h.qty = (int) Math.min(held.qty, r.qty != null ? r.qty : held.qty);
        h.price = price;
        h.why = hitTp ? "reached target " + jsNum(r.takeProfit) : "fell to stop " + jsNum(r.stopLoss);
        return h;
    }

    // ---------- rebalancePlan() ----------

    static final class Order { String symbol; boolean buy; int qty; double price; }
    static final class Plan { List<Order> orders = new ArrayList<>(); double drift; List<String> missing = new ArrayList<>(); }

    static Plan rebalancePlan(Account a, List<String> symbols, List<Double> weights, Map<String, Double> prices) {
        Plan plan = new Plan();
        Totals b = totals(a, prices);
        for (String s : symbols) if (priced(prices, s) == null) plan.missing.add(s);
        double drift = 0;
        for (int i = 0; i < symbols.size(); i++) {
            Pos p = a.positions.get(symbols.get(i));
            Double pr = prices.get(symbols.get(i));
            double price = pr == null ? 0 : pr;
            double value = p != null && !p.future && p.qty > 0 ? p.qty * price : 0;
            double now = b.equity > 0 ? (value / b.equity) * 100 : 0;
            drift = Math.max(drift, Math.abs(now - weights.get(i)));
        }
        plan.drift = drift;
        if (!plan.missing.isEmpty() || b.equity <= 0) return plan;

        List<Order> sells = new ArrayList<>();
        List<Order> buys = new ArrayList<>();
        for (int i = 0; i < symbols.size(); i++) {
            String s = symbols.get(i);
            double price = prices.get(s);
            Pos held = a.positions.get(s);
            double have = held != null && !held.future && held.qty > 0 ? held.qty : 0;
            double want = Math.floor((b.equity * weights.get(i)) / 100 / price);
            if (want < have) sells.add(order(s, false, (int) (have - want), price));
            if (want > have) buys.add(order(s, true, (int) (want - have), price));
        }
        double sold = 0;
        for (Order o : sells) sold += o.qty * o.price;
        double cash = a.cash + sold;
        plan.orders.addAll(sells);
        for (Order o : buys) {
            int qty = (int) Math.min(o.qty, Math.floor(cash / o.price));
            if (qty > 0) {
                plan.orders.add(order(o.symbol, true, qty, o.price));
                cash -= qty * o.price;
            }
        }
        return plan;
    }

    private static Order order(String s, boolean buy, int qty, double price) {
        Order o = new Order();
        o.symbol = s; o.buy = buy; o.qty = qty; o.price = price;
        return o;
    }

    // ---------- runRules() ----------

    /** Symbols the active rules need prices for. */
    static Set<String> symbols(List<Rule> rules) {
        Set<String> out = new LinkedHashSet<>();
        for (Rule r : rules) {
            if (!r.on) continue;
            if (r.price) out.add(r.symbol);
            else out.addAll(r.symbols);
        }
        return out;
    }

    static Result run(Account start, List<Rule> rules, Map<String, Double> prices, long now) {
        Result res = new Result();
        Account account = start;
        res.rules = rules;
        for (Rule r : rules) {
            if (r.price) {
                Hit hit = priceOrder(r, account, prices.get(r.symbol));
                if (hit == null) continue;
                Fired f = new Fired();
                f.ruleId = r.id;
                f.time = now;
                try {
                    account = applyOrder(account, r.symbol, false, hit.qty, hit.price, now, prices);
                    f.ok = true;
                    f.text = "Sold " + hit.qty + " " + r.symbol + " at " + toFixed(hit.price, 2) + ": " + hit.why + ".";
                } catch (RuntimeException e) {
                    f.ok = false;
                    f.text = r.symbol + " " + hit.why + ", but the sale failed: " + e.getMessage();
                }
                r.on = false; // a target fires once
                res.fired.add(f);
            } else {
                if (!r.on) continue;
                Plan plan = rebalancePlan(account, r.symbols, r.weights, prices);
                if (!(r.auto && plan.drift >= r.drift)) continue;
                if (!plan.missing.isEmpty()) continue;
                int done = 0;
                for (Order o : plan.orders) {
                    try {
                        account = applyOrder(account, o.symbol, o.buy, o.qty, o.price, now, prices);
                        done++;
                    } catch (RuntimeException ignored) {
                        // the rest still runs
                    }
                }
                r.last = now;
                Fired f = new Fired();
                f.ruleId = r.id;
                f.ok = true;
                f.time = now;
                f.text = done > 0 ? "Rebalanced with " + done + " " + (done == 1 ? "order" : "orders") + " (largest drift was " + toFixed(plan.drift, 1) + " points)."
                        : "Rebalance checked: already on target.";
                res.fired.add(f);
            }
        }
        res.account = account;
        return res;
    }
}
