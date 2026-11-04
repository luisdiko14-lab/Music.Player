package com.musicplayer.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat

object NotificationUtils {
    const val CHANNEL_ID = "music_player_playback"
    const val CHANNEL_NAME = "Playback"

    fun createChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Playback notifications for Music.Player"
            setSound(null, null)
        }
        manager?.createNotificationChannel(channel)
    }

    fun buildPlaybackNotification(
        context: Context,
        trackTitle: String,
        isPlaying: Boolean,
    ): NotificationCompat.Builder {
        createChannel(context)
        val actionText = if (isPlaying) "Pause" else "Play"
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Now playing")
            .setContentText(trackTitle)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                android.R.drawable.ic_media_pause,
                actionText,
                null,
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop",
                null,
            )
    }
}
