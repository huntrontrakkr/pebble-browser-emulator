// SPDX-License-Identifier: GPL-3.0-only
// From Core Devices mobileapp; see ../../../../upstream.json. Bodies are unchanged.
package coredevices.pebble.ui

import com.multiplatform.webview.request.RequestInterceptor
import com.multiplatform.webview.request.WebRequest
import com.multiplatform.webview.request.WebRequestInterceptResult
import com.multiplatform.webview.web.WebViewNavigator
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun normalizeWatchappSettingsUrl(url: String): String {
    val parsed = runCatching { Url(url) }.getOrNull() ?: return url
    val host = parsed.host.lowercase()

    val isLegacyRawGitHost = host == "cdn.rawgit.com" || host == "rawgit.com"
    if (!isLegacyRawGitHost) return url

    return URLBuilder(parsed).apply {
        this.host = "raw.githack.com"
    }.buildString()
}

internal class SettingsRequestInterceptor(
    private val onError: suspend () -> Unit,
    private val onSuccess: suspend (String) -> Unit,
) : RequestInterceptor {
    private val PREFIX = "pebblejs://close" // non-compliant intercept for close, because some apps just use "close"
    private val scope = CoroutineScope(Dispatchers.Default)

    override fun onInterceptUrlRequest(
        request: WebRequest,
        navigator: WebViewNavigator,
    ): WebRequestInterceptResult {
        if (!request.url.startsWith(PREFIX)) {
            return WebRequestInterceptResult.Allow
        }

        // Matches PREFIX followed by #, /, or /? 
        // Ideally all apps would send pebblejs://close#param1=value1&param2=value2 but it's not the case.
        // The original Pebble Technology Corp App did deviate from the official spec and handled these wrong cases too.
        val closeUrlRegex = Regex("""^pebblejs://close(?:#|/\?|/)(.*)$""")

        val data = closeUrlRegex.find(request.url)?.groupValues?.get(1)?.decodeURLPart()
        if (data?.isNotEmpty() == true) {
            scope.launch {
                delay(10)
                onSuccess(data)
            }
        } else {
            scope.launch {
                delay(10)
                onError()
            }
        }

        return WebRequestInterceptResult.Reject
    }
}
