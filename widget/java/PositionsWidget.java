package com.zlhng.tradingapp;

import android.content.Context;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Paper account positions: value, profit or loss and share of the account. */
public class PositionsWidget extends BaseWidget {
    private static final class Pos {
        String label;
        double qty, value, pnl, pnlPct;
        boolean priced;
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
            Pos r = new Pos();
            r.label = p.optString("l", symbol);
            r.qty = p.optDouble("q", 0);
            r.priced = q != null && q.optDouble("p", 0) > 0;
            double price = r.priced ? q.optDouble("p", 0) : cost;
            r.value = r.qty * price;
            r.pnl = r.value - r.qty * cost;
            r.pnlPct = cost > 0 ? (price - cost) / cost * 100 : 0;
            b.equity += r.value;
            b.rows.add(r);
        }
        b.rows.sort((x, y) -> Double.compare(y.value, x.value));
        return b;
    }

    @Override
    String title(Context c) {
        Book b = book(c);
        if (b == null) return "Paper positions";
        double total = b.equity - b.start;
        return "Paper $" + money(b.equity) + (b.start > 0 ? "  " + signed(total / b.start * 100, 2) + "%" : "");
    }

    @Override
    int rowHeightDp() {
        return 40;
    }

    @Override
    String emptyText(Context c) {
        return WidgetData.paper(c) == null ? "Open TradingApp once to load your paper account." : "No open paper positions.";
    }

    @Override
    int fill(Context c, RemoteViews root, int maxRows) {
        Book b = book(c);
        if (b == null) return 0;
        int n = 0;
        for (Pos r : b.rows) {
            if (n >= maxRows) break;
            String qty = r.qty == Math.rint(r.qty) ? String.valueOf((long) r.qty) : String.valueOf(r.qty);
            String weight = b.equity > 0 ? String.format(java.util.Locale.US, "%.1f%%", r.value / b.equity * 100) : "";
            root.addView(R.id.rows, row(c, r.label, qty + " sh · " + weight, "$" + money(r.value),
                    r.priced ? signed(r.pnl, 2) + " (" + signed(r.pnlPct, 1) + "%)" : "at cost", tone(c, r.pnl)));
            n++;
        }
        return n;
    }
}
