// SPDX-License-Identifier: GPL-3.0-only
package com.multiplatform.webview.request
import com.multiplatform.webview.web.WebViewNavigator
interface RequestInterceptor {
    fun onInterceptUrlRequest(request: WebRequest, navigator: WebViewNavigator): WebRequestInterceptResult
}
data class WebRequest(val url: String)
enum class WebRequestInterceptResult { Allow, Reject }
