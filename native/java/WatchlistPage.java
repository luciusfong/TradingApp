package com.zlhng.tradingapp;

import android.content.Context;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

final class WatchlistPage extends WidgetPage {
    @Override
    String name() {
        return "Watchlist";
    }

    @Override
    int rowHeightDp() {
        return 40;
    }

    @Override
    String emptyText(Context c) {
        return WidgetData.watchlist(c) == null ? "Open TradingApp once to load your watchlist." : "Your watchlist is empty.";
    }

    @Override
    int fill(Context c, RemoteViews root, int maxRows) {
        JSONArray list = WidgetData.watchlist(c);
        if (list == null) return 0;
        JSONObject quotes = WidgetData.cache(c).optJSONObject("quotes");
        int n = 0;
        for (int i = 0; i < list.length() && n < maxRows; i++) {
            JSONObject h = list.optJSONObject(i);
            if (h == null) continue;
            String symbol = h.optString("s");
            JSONObject q = quotes == null ? null : quotes.optJSONObject(symbol);
            double chg = q == null ? 0 : q.optDouble("c", 0);
            root.addView(R.id.rows, row(c, h.optString("l", symbol), h.optString("n", ""),
                    q == null ? "—" : money(q.optDouble("p", 0)),
                    q == null ? "" : arrow(chg) + signed(chg, 2) + "%", tone(c, chg)));
            n++;
        }
        return n;
    }
}
