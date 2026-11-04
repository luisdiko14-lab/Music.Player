package com.musicplayer.android

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class MusicForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        NotificationUtils.createChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val trackName = intent?.getStringExtra(EXTRA_TRACK_NAME) ?: "Now playing"
        val notification = NotificationUtils.buildPlaybackNotification(this, trackName, true)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .build()

        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TRACK_NAME = "extra_track_name"
        const val NOTIFICATION_ID = 1001
    }
}
