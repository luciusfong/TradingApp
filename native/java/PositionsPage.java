package com.zlhng.tradingapp;

import android.content.Context;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Paper account: total first, then each position's size, profit or loss and share of the account. Mirrors breakdown() in src/lib/paper.ts. */
final class PositionsPage extends WidgetPage {
    private static final class Pos {
        String label;
        double qty, value, pnl, pnlPct;
        boolean priced, future;
    }

    private static final class Book {
        final List<Pos> rows = new ArrayList<>();
        double equity, start;
    }

    private static Book book(Context c) {
        JSONObject paper = WidgetData.paper(c);
        if (paper == null) return null;
        JSONObject quotes = WidgetData.cache(c).optJSONObject("quotes");
        Book b = new Book();
        b.start = paper.optDouble("start", 0);
        b.equity = paper.optDouble("cash", 0);
        JSONArray list = paper.optJSONArray("positions");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject p = list.optJSONObject(i);
            if (p == null) continue;
            String symbol = p.optString("s");
            JSONObject q = quotes == null ? null : quotes.optJSONObject(symbol);
            double cost = p.optDouble("c", 0);
            double mult = p.optDouble("m", 1);
            Pos r = new Pos();
            r.label = p.optString("l", symbol);
            r.qty = p.optDouble("q", 0);
            r.future = p.optBoolean("f", false);
            r.priced = q != null && q.optDouble("p", 0) > 0;
            double price = r.priced ? q.optDouble("p", 0) : cost;
            r.value = Math.abs(r.qty) * price * mult;
            r.pnl = (price - cost) * r.qty * mult;
            r.pnlPct = cost > 0 ? (price - cost) / cost * 100 * Math.signum(r.qty) : 0;
            b.equity += r.future ? r.pnl : r.qty * price;
            b.rows.add(r);
        }
        b.rows.sort((x, y) -> Double.compare(y.value, x.value));
        return b;
    }

    @Override
    String name() {
        return "Positions";
    }

    @Override
    int rowHeightDp() {
        return 40;
    }

    @Override
    String emptyText(Context c) {
        return "Open TradingApp once to load your paper account.";
    }

    @Override
    int fill(Context c, RemoteViews root, int maxRows) {
        Book b = book(c);
        if (b == null) return 0;
        double total = b.equity - b.start;
        int count = b.rows.size();
        root.addView(R.id.rows, row(c, "Paper account", count + (count == 1 ? " position" : " positions"), "$" + money(b.equity),
                b.start > 0 ? signed(total / b.start * 100, 2) + "% since start" : "", tone(c, total)));
        int n = 1;
        for (Pos r : b.rows) {
            if (n >= maxRows) break;
            String qty = (r.qty < 0 ? "Short " : "") + (long) Math.abs(r.qty);
            String weight = b.equity > 0 ? String.format(Locale.US, "%.1f%%", r.value / b.equity * 100) : "";
            root.addView(R.id.rows, row(c, r.label, qty + (r.future ? " ct · " : " sh · ") + weight, "$" + money(r.value),
                    r.priced ? signed(r.pnl, 2) + " (" + signed(r.pnlPct, 1) + "%)" : "at cost", tone(c, r.pnl)));
            n++;
        }
        return n;
    }
}
