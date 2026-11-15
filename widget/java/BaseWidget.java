package com.zlhng.tradingapp;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;

import java.util.Date;
import java.util.Locale;

/** Shared frame for the three widgets: title, updated time with refresh, and a column of rows. */
public abstract class BaseWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.zlhng.tradingapp.WIDGET_REFRESH";
    static final int PI_FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

    abstract String title(Context c);

    abstract int rowHeightDp();

    /** Adds up to maxRows rows to R.id.rows and returns how many were added. */
    abstract int fill(Context c, RemoteViews root, int maxRows);

    abstract String emptyText(Context c);

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) render(c, m, id);
        refreshAsync(c, false);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle options) {
        render(c, m, id);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (ACTION_REFRESH.equals(intent.getAction())) refreshAsync(c, true);
        else super.onReceive(c, intent);
    }

    private void refreshAsync(Context c, final boolean force) {
        final PendingResult pending = goAsync();
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                WidgetData.refresh(app, force);
                renderAll(app);
            } finally {
                pending.finish();
            }
        }).start();
    }

    /** Called when the app goes to the background, so new watchlist items and trades show up straight away. */
    static void refreshFromApp(Context c) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            renderAll(app);
            WidgetData.refresh(app, true);
            renderAll(app);
        }).start();
    }

    static void renderAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        BaseWidget[] all = {new WatchlistWidget(), new PositionsWidget(), new NewsWidget()};
        for (BaseWidget w : all) {
            for (int id : m.getAppWidgetIds(new ComponentName(c, w.getClass()))) w.render(c, m, id);
        }
    }

    void render(Context c, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
        v.setTextViewText(R.id.title, title(c));
        long at = WidgetData.updatedAt(c);
        v.setTextViewText(R.id.stamp, (at == 0 ? "Tap to load" : DateFormat.getTimeFormat(c).format(new Date(at))) + "  ↻");

        int height = m.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        int maxRows = height <= 0 ? 3 : Math.max(1, Math.min(12, (height - 48) / rowHeightDp()));
        v.removeAllViews(R.id.rows);
        int n = fill(c, v, maxRows);
        v.setViewVisibility(R.id.empty, n == 0 ? View.VISIBLE : View.GONE);
        if (n == 0) v.setTextViewText(R.id.empty, emptyText(c));

        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 0, open, PI_FLAGS));
        Intent refresh = new Intent(c, getClass()).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.stamp, PendingIntent.getBroadcast(c, 0, refresh, PI_FLAGS));
        m.updateAppWidget(id, v);
    }

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
