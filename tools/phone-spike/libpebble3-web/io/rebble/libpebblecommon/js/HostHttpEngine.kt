package io.rebble.libpebblecommon.js

import io.ktor.client.engine.HttpClientEngineBase
import io.ktor.client.engine.HttpClientEngineConfig
import io.ktor.client.engine.callContext
import io.ktor.client.engine.mergeHeaders
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpProtocolVersion
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.util.date.GMTDate
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.InternalAPI
import io.rebble.libpebblecommon.util.blockingCalls
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.coroutines.resume
import kotlin.io.encoding.Base64

/**
 * The HTTP engine under upstream's XMLHTTPRequestManager in the browser: each request
 * goes to the page's phone network (`pebblePhoneHost.network`, libpebble-network.ts),
 * which applies the session's network setting, limits and CORS, as the built-in phone
 * does. The manager and its `XMLHttpRequest` class are upstream's, unchanged; only the
 * transport under ktor is the browser's. A request the host cannot make fails as an
 * exception, which upstream reports to the app as an `error` event.
 *
 * Upstream makes a synchronous XMLHttpRequest with `runBlocking`. Inside one, the
 * engine asks the host to block on the worker's own request, and ktor runs inline
 * (the engine's dispatcher is unconfined), so the call completes without suspending.
 */
internal class HostHttpEngine : HttpClientEngineBase("pkjs-host") {
    override val config = HttpClientEngineConfig().apply { dispatcher = Dispatchers.Unconfined }

    @InternalAPI
    override suspend fun execute(data: HttpRequestData): HttpResponseData {
        val callContext = callContext()
        val requestTime = GMTDate()
        val headers = linkedMapOf<String, String>()
        mergeHeaders(data.headers, data.body) { key, value ->
            // The browser sets the length itself and refuses to take it from a page.
            if (!key.equals(HttpHeaders.ContentLength, ignoreCase = true))
                headers[key] = headers[key]?.let { "$it, $value" } ?: value
        }
        // Upstream's manager encodes a string body as UTF-8 and passes a typed array's bytes.
        // Valid UTF-8 goes as text, so the browser sets text's default content type as a
        // WebView's XMLHttpRequest does; anything else goes as bytes.
        val bytes = when (val content = data.body) {
            is OutgoingContent.NoContent -> null
            is OutgoingContent.ByteArrayContent -> content.bytes()
            else -> throw IOException("Request bodies of type ${content::class.simpleName} are not supported")
        }
        val text = bytes?.let { runCatching { it.decodeToString(throwOnInvalidSequence = true) }.getOrNull() }
        val request = buildJsonObject {
            put("method", data.method.value)
            put("url", data.url.toString())
            put("headers", JsonObject(headers.mapValues { JsonPrimitive(it.value) }))
            put("body", text)
            if (bytes != null && text == null) put("bodyBase64", Base64.encode(bytes))
        }.toString()

        val reply = if (blockingCalls > 0) hostRequestSync(request)
        else suspendCancellableCoroutine<String> { continuation ->
            val id = hostRequest(request) { result -> if (continuation.isActive) continuation.resume(result) }
            continuation.invokeOnCancellation { hostCancel(id) }
        }
        val result = Json.parseToJsonElement(reply).jsonObject
        result["error"]?.let {
            throw IOException("${it.jsonPrimitive.content}: ${result["message"]?.jsonPrimitive?.content}")
        }
        val status = result["status"]!!.jsonPrimitive.int
        val statusText = result["statusText"]?.jsonPrimitive?.content.orEmpty()
        val responseHeaders = Headers.build {
            result["headers"]?.jsonObject?.forEach { (key, value) -> append(key, value.jsonPrimitive.content) }
        }
        val bytes = Base64.decode(result["bodyBase64"]?.jsonPrimitive?.content.orEmpty())
        return HttpResponseData(
            HttpStatusCode(status, statusText.ifEmpty { HttpStatusCode.fromValue(status).description }),
            requestTime,
            responseHeaders,
            HttpProtocolVersion.HTTP_1_1,
            ByteReadChannel(bytes),
            callContext,
        )
    }
}

private fun hostRequest(json: String, done: (String) -> Unit): Int =
    js("globalThis.pebblePhoneHost.network.request(json, done)")

private fun hostRequestSync(json: String): String =
    js("globalThis.pebblePhoneHost.network.requestSync(json)")

private fun hostCancel(id: Int): Unit = js("{ globalThis.pebblePhoneHost.network.cancel(id); }")
