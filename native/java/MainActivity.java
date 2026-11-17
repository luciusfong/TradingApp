package com.zlhng.tradingapp;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        noteTab(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        noteTab(intent);
    }

    // While the app is on screen it runs the paper strategies itself, so the background job stands aside.
    @Override
    public void onResume() {
        super.onResume();
        StrategyCheck.setForeground(this, true);
    }

    // Leaving the app: push the latest watchlist and paper account to the home-screen widget,
    // and bring the background schedule (alerts, strategies) in line with the settings.
    @Override
    public void onPause() {
        super.onPause();
        StrategyCheck.setForeground(this, false);
        TradingWidget.refreshFromApp(this);
        ScreenerJob.sync(this);
    }

    // A tapped alert names the tab to open. The web app reads it from the same store
    // Capacitor Preferences uses (takeNavTab() in src/lib/native.ts).
    private void noteTab(Intent intent) {
        String tab = intent == null ? null : intent.getStringExtra("tab");
        if (tab == null) return;
        getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().putString("nav.tab", tab).apply();
        intent.removeExtra("tab");
    }
}
