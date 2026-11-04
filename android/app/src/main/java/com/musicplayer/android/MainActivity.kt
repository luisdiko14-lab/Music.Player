package com.musicplayer.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.musicplayer.android.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        binding.statusText.text = if (granted) "Notifications enabled." else "Notification permission was denied."
    }

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        binding.statusText.text = if (Settings.canDrawOverlays(this)) {
            "Pop-up window permission granted."
        } else {
            "Pop-up window permission is still required."
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val webView = binding.playerWebView
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.databaseEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                binding.statusText.text = "Music.Player loaded in the Android WebView."
            }
        }

        binding.startServiceButton.setOnClickListener {
            startPlaybackService()
        }

        binding.stopServiceButton.setOnClickListener {
            stopPlaybackService()
        }

        binding.batteryButton.setOnClickListener {
            requestBatteryOptimizationException()
        }

        binding.overlayButton.setOnClickListener {
            requestOverlayPermission()
        }

        binding.floatingToggleButton.setOnClickListener {
            toggleFloatingWindow()
        }

        webView.loadUrl("file:///android_asset/music-player/index.html")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun startPlaybackService() {
        val serviceIntent = Intent(this, MusicForegroundService::class.java).apply {
            putExtra(MusicForegroundService.EXTRA_TRACK_NAME, "Your current track")
        }
        ContextCompat.startForegroundService(this, serviceIntent)
        binding.statusText.text = "Playback service started."
    }

    private fun stopPlaybackService() {
        stopService(Intent(this, MusicForegroundService::class.java))
        binding.statusText.text = "Playback service stopped."
    }

    private fun requestBatteryOptimizationException() {
        val powerManager = getSystemService(PowerManager::class.java)
        val packageName = packageName
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
            binding.statusText.text = "Battery optimization request sent."
            return
        }
        binding.statusText.text = "Battery optimization is already disabled."
    }

    private fun requestOverlayPermission() {
        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            overlayPermissionLauncher.launch(intent)
            return
        }
        binding.statusText.text = "Pop-up window permission already granted."
    }

    private fun toggleFloatingWindow() {
        if (!Settings.canDrawOverlays(this)) {
            binding.statusText.text = "Allow the pop-up window permission before using the floating player."
            requestOverlayPermission()
            return
        }

        val serviceIntent = Intent(this, FloatingPlayerService::class.java)
        val isRunning = isServiceRunning(FloatingPlayerService::class.java)
        if (isRunning) {
            stopService(serviceIntent)
            binding.statusText.text = "Floating player closed."
        } else {
            ContextCompat.startForegroundService(this, serviceIntent)
            binding.statusText.text = "Floating player opened."
        }
    }

    private fun isServiceRunning(serviceClass: Class<*>): Boolean {
        val manager = getSystemService(ActivityManager::class.java)
        return manager?.getRunningServices(Int.MAX_VALUE)
            ?.any { it.service.className == serviceClass.name } == true
    }
}
