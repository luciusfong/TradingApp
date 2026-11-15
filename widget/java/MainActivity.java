package com.zlhng.tradingapp;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Leaving the app: push the latest watchlist and paper account to the home-screen widgets.
    @Override
    public void onPause() {
        super.onPause();
        BaseWidget.refreshFromApp(this);
    }
}
