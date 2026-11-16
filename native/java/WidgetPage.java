package com.zlhng.tradingapp;

import android.content.Context;
import android.widget.RemoteViews;

import java.util.Locale;

/** One tab of the home-screen widget: Watchlist, Positions or News. */
abstract class WidgetPage {
    abstract String name();

    abstract int rowHeightDp();

    /** Adds up to maxRows rows to R.id.rows and returns how many were added. */
    abstract int fill(Context c, RemoteViews root, int maxRows);

    abstract String emptyText(Context c);

    /** A two-line row: name and detail on the left, value and change on the right. */
    static RemoteViews row(Context c, String t1, String t2, String r1, String r2, int r2Color) {
        RemoteViews r = new RemoteViews(c.getPackageName(), R.layout.widget_row);
        r.setTextViewText(R.id.t1, t1);
        r.setTextViewText(R.id.t2, t2 == null ? "" : t2);
        r.setTextViewText(R.id.r1, r1);
        r.setTextViewText(R.id.r2, r2);
        r.setTextColor(R.id.r2, r2Color);
        return r;
    }

    static int tone(Context c, double v) {
        return c.getColor(v > 0.004 ? R.color.w_pos : v < -0.004 ? R.color.w_neg : R.color.w_ink3);
    }

    static String money(double v) {
        return String.format(Locale.US, "%,.2f", v);
    }

    static String signed(double v, int decimals) {
        String body = String.format(Locale.US, "%,." + decimals + "f", Math.abs(v));
        return (v > 0.004 ? "+" : v < -0.004 ? "−" : "") + body;
    }

    static String arrow(double v) {
        return v > 0.004 ? "▲ " : v < -0.004 ? "▼ " : "";
    }
}
