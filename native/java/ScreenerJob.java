package com.zlhng.tradingapp;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * About once an hour, including after a restart of the phone: checks the Screener filters
 * (ScreenerCheck) when alerts are on, and runs the paper strategies (StrategyCheck) when
 * background strategies are on and a rule is active.
 */
public class ScreenerJob extends JobService {
    private static final int HOURLY = 4101;
    private static final int ONCE = 4102;
    private static final long HOUR = 60 * 60 * 1000L;

    /** Brings the schedule in line with the app's setting. Called whenever the app goes to the background. */
    static void sync(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            boolean alerts = ScreenerCheck.enabled(c);
            if (!alerts) {
                js.cancel(ONCE);
                ScreenerCheck.forget(c);
            }
            if (!alerts && !StrategyCheck.enabled(c)) {
                js.cancel(HOURLY);
                return;
            }
            ComponentName me = new ComponentName(c, ScreenerJob.class);
            if (js.getPendingJob(HOURLY) == null) {
                try {
                    js.schedule(new JobInfo.Builder(HOURLY, me).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(HOUR).setPersisted(true).build());
                } catch (Exception e) {
                    // Without the start-up permission the job cannot survive a restart; schedule it anyway.
                    js.schedule(new JobInfo.Builder(HOURLY, me).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(HOUR).build());
                }
            }
            // New or changed symbols or filters: record what matches now, instead of waiting for the next hourly run.
            if (alerts && ScreenerCheck.needsBaseline(c) && js.getPendingJob(ONCE) == null) {
                js.schedule(new JobInfo.Builder(ONCE, me).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setOverrideDeadline(5 * 60 * 1000L).build());
            }
        } catch (Exception ignored) {
            // alerts simply stay as they were
        }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context app = getApplicationContext();
        new Thread(() -> {
            try {
                ScreenerCheck.run(app);
                if (params.getJobId() == HOURLY) StrategyCheck.run(app);
            } finally {
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
