package com.zlhng.tradingapp;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;

import java.util.Date;

/**
 * The home-screen widget: one widget with Watchlist, Positions and News tabs.
 * Android gives widgets only taps and vertical swipes (sideways swipes belong to
 * the home screen), so the pages are switched by tapping a tab, not by swiping.
 */
public class TradingWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.zlhng.tradingapp.WIDGET_REFRESH";
    static final String ACTION_TAB = "com.zlhng.tradingapp.WIDGET_TAB";
    static final int PI_FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    private static final WidgetPage[] PAGES = {new WatchlistPage(), new PositionsPage(), new NewsPage()};
    private static final int[] TABS = {R.id.tab0, R.id.tab1, R.id.tab2};

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(WidgetData.PREFS, Context.MODE_PRIVATE);
    }

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
    public void onDeleted(Context c, int[] ids) {
        SharedPreferences.Editor e = prefs(c).edit();
        for (int id : ids) e.remove("tab_" + id);
        e.apply();
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)) {
            refreshAsync(c, true);
        } else if (ACTION_TAB.equals(action)) {
            int id = intent.getIntExtra("id", AppWidgetManager.INVALID_APPWIDGET_ID);
            if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return;
            prefs(c).edit().putInt("tab_" + id, intent.getIntExtra("tab", 0)).apply();
            render(c, AppWidgetManager.getInstance(c), id);
        } else {
            super.onReceive(c, intent);
        }
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
        for (int id : m.getAppWidgetIds(new ComponentName(c, TradingWidget.class))) render(c, m, id);
    }

    static void render(Context c, AppWidgetManager m, int id) {
        int tab = Math.max(0, Math.min(PAGES.length - 1, prefs(c).getInt("tab_" + id, 0)));
        WidgetPage page = PAGES[tab];
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
        for (int i = 0; i < PAGES.length; i++) {
            v.setTextViewText(TABS[i], PAGES[i].name());
            v.setTextColor(TABS[i], c.getColor(i == tab ? R.color.w_ink : R.color.w_ink3));
            // The data address makes each tab's intent distinct, so every tab keeps its own extras.
            Intent pick = new Intent(c, TradingWidget.class).setAction(ACTION_TAB)
                    .setData(Uri.parse("tradingapp://widget/" + id + "/" + i)).putExtra("id", id).putExtra("tab", i);
            v.setOnClickPendingIntent(TABS[i], PendingIntent.getBroadcast(c, 0, pick, PI_FLAGS));
        }
        long at = WidgetData.updatedAt(c);
        v.setTextViewText(R.id.stamp, (at == 0 ? "Tap to load" : DateFormat.getTimeFormat(c).format(new Date(at))) + "  ↻");

        int height = m.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        int maxRows = height <= 0 ? 3 : Math.max(1, Math.min(12, (height - 52) / page.rowHeightDp()));
        v.removeAllViews(R.id.rows);
        int n = page.fill(c, v, maxRows);
        v.setViewVisibility(R.id.empty, n == 0 ? View.VISIBLE : View.GONE);
        if (n == 0) v.setTextViewText(R.id.empty, page.emptyText(c));

        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 0, open, PI_FLAGS));
        Intent refresh = new Intent(c, TradingWidget.class).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.stamp, PendingIntent.getBroadcast(c, 0, refresh, PI_FLAGS));
        m.updateAppWidget(id, v);
    }
}
