// SPDX-License-Identifier: GPL-3.0-only
@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.ui.ExperimentalComposeUiApi::class, kotlin.js.ExperimentalWasmJsInterop::class)
package coredevices.pebble.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.window.ComposeViewport
import com.multiplatform.webview.request.WebRequest
import com.multiplatform.webview.request.WebRequestInterceptResult
import com.multiplatform.webview.web.WebViewNavigator

private var title by mutableStateOf("")
private var loaded by mutableStateOf(false)
private var interceptor: SettingsRequestInterceptor? = null
private fun bind(open: (String, String) -> Unit, navigate: (String) -> Unit): Unit =
    js("window.phonePort.bind(open, navigate)")
private fun showPage(url: String): Unit = js("window.phonePort.showPage(url)")
private fun closePage(response: String?): Unit = js("window.phonePort.close(response)")
private fun sizePage(x: Float, y: Float, width: Float, height: Float): Unit =
    js("window.phonePort.resize(x, y, width, height)")

fun main() {
    ComposeViewport(viewportContainerId = "phone-screen") {
        MaterialTheme {
            if (loaded) WatchappSettingsScreen(title)
        }
    }
    bind({ url, name ->
        title = name
        interceptor = SettingsRequestInterceptor(
            onSuccess = { data -> closePage(data) },
            onError = { closePage(null) },
        )
        loaded = true
        showPage(normalizeWatchappSettingsUrl(url))
    }, { url ->
        try {
            val result = interceptor?.onInterceptUrlRequest(WebRequest(url), WebViewNavigator())
            if (result == WebRequestInterceptResult.Allow) showPage(url)
        } catch (error: Throwable) {
            // A malformed return is an error; never turn it into an applied setting.
            reportError(error.message ?: "Invalid configuration return")
        }
    })
}
private fun reportError(message: String): Unit = js("window.phonePort.error(message)")

// Scaffold and header ported from WatchappSettingsScreen at the pinned upstream commit.
// The browser session replaces native navigation/DI; the app-owned WebView is a DOM overlay.
@Composable
fun WatchappSettingsScreen(title: String) {
    val density = LocalDensity.current.density
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("App Settings")
                        Text("Configuring $title", style = MaterialTheme.typography.labelMedium)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { closePage(null) }) {
                        Icon(Icons.AutoMirrored.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { paddingValues ->
        Box(Modifier.fillMaxSize().padding(paddingValues).onGloballyPositioned {
            // The DOM WebView leaves this content box with zero height. Its unclipped position
            // still locates the native header's lower edge; clipped bounds would collapse to zero.
            val position = it.positionInWindow()
            sizePage(position.x / density, position.y / density, it.size.width / density, it.size.height / density)
        })
    }
}
