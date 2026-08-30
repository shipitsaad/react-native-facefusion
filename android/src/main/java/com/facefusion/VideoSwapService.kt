package com.facefusion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * A notification shell, not a worker.
 *
 * Android's actual rule for a job that runs minutes in the background is about *process
 * priority*, not which thread does the work: a foreground service with an active
 * notification keeps the whole process from being treated as killable. So this component
 * does nothing but call [startForeground] and sit there — the real decode/swap/encode loop
 * still runs on [FacefusionModule]'s own `videoWorker` thread, in the same process, which is
 * what keeps [VideoSwap] a plain Kotlin object with a normal return value instead of needing
 * a callback channel back from a Service to a TurboModule's `Promise`.
 *
 * `foregroundServiceType="mediaProcessing"` (declared in the manifest) is required from
 * targetSdk 34 for any foreground service — chosen over `dataSync` as the type that actually
 * describes what this is. Below API 34 the type argument does not exist yet, so
 * [start] branches on it.
 */
class VideoSwapService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel(this)
    val notification = buildNotification(this, "Swapping video…")
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL_ID = "facefusion_video_swap"
    private const val NOTIFICATION_ID = 1001

    fun start(context: android.content.Context) {
      ensureChannel(context)
      context.startForegroundService(Intent(context, VideoSwapService::class.java))
    }

    fun stop(context: android.content.Context) {
      context.stopService(Intent(context, VideoSwapService::class.java))
    }

    /** Updates the already-shown notification in place — no need to go back through the
     *  Service's `onStartCommand`, since [NotificationManager.notify] on the same id just
     *  replaces what's displayed. Throttled by the caller, same cadence as the JS event. */
    fun updateProgress(context: android.content.Context, text: String) {
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      nm.notify(NOTIFICATION_ID, buildNotification(context, text))
    }

    private fun ensureChannel(context: android.content.Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Video swap", NotificationManager.IMPORTANCE_LOW)
      )
    }

    // A library ships no drawable resources of its own worth trusting for a status-bar
    // icon, so this borrows the CONSUMER app's own launcher icon -- always present, unlike
    // any icon id this package could hardcode. Full-colour icons render squared-off on some
    // versions rather than as a proper alpha-mask glyph; cosmetic, not a functional issue.
    private fun buildNotification(context: android.content.Context, text: String): Notification =
      Notification.Builder(context, CHANNEL_ID)
        .setContentTitle("FaceFusion")
        .setContentText(text)
        .setSmallIcon(context.applicationInfo.icon)
        .setOngoing(true)
        .build()
  }
}
