package com.zlhng.tradingapp;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/** Latest market headlines. Tapping a headline opens the article. */
final class NewsPage extends WidgetPage {
    @Override
    String name() {
        return "News";
    }

    @Override
    int rowHeightDp() {
        return 58;
    }

    @Override
    String emptyText(Context c) {
        return "No headlines yet. Tap the time to refresh.";
    }

    private static String ago(long at) {
        long m = Math.max(0, (System.currentTimeMillis() - at) / 60000);
        if (m < 1) return "now";
        if (m < 60) return m + "m ago";
        if (m < 1440) return Math.round(m / 60.0) + "h ago";
        return Math.round(m / 1440.0) + "d ago";
    }

    @Override
    int fill(Context c, RemoteViews root, int maxRows) {
        JSONArray news = WidgetData.cache(c).optJSONArray("news");
        if (news == null) return 0;
        int n = 0;
        for (int i = 0; i < news.length() && n < maxRows; i++) {
            JSONObject o = news.optJSONObject(i);
            if (o == null) continue;
            RemoteViews r = new RemoteViews(c.getPackageName(), R.layout.widget_row_news);
            r.setTextViewText(R.id.t1, o.optString("t"));
            String source = o.optString("s");
            r.setTextViewText(R.id.t2, (source.isEmpty() ? "" : source + " · ") + ago(o.optLong("at")));
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(o.optString("u"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            r.setOnClickPendingIntent(R.id.row, PendingIntent.getActivity(c, 100 + i, view, TradingWidget.PI_FLAGS));
            root.addView(R.id.rows, r);
            n++;
        }
        return n;
    }
}
