package io.rebble.libpebblecommon.js

import co.touchlab.kermit.Logger
import io.ktor.client.HttpClient
import io.rebble.libpebblecommon.NotificationConfigFlow
import io.rebble.libpebblecommon.connection.AppContext
import io.rebble.libpebblecommon.connection.LibPebble
import io.rebble.libpebblecommon.database.entity.LockerEntry
import io.rebble.libpebblecommon.io.rebble.libpebblecommon.js.JSCGeolocationInterface
import io.rebble.libpebblecommon.metadata.pbw.appinfo.PbwAppInfo
import io.rebble.libpebblecommon.plugin.PluginRegistry
import io.rebble.libpebblecommon.services.appmessage.AppMessageResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlin.io.encoding.Base64
import kotlin.time.Duration.Companion.milliseconds
import kotlin.uuid.Uuid

/**
 * PebbleKit JS in the browser, following upstream's iOS JavaScriptCore runner: a bare
 * JS engine (no WebView) with upstream's standard library, `startup.js` and the app's
 * own JS, and upstream's interfaces reached through one native dispatcher. The engine
 * is the emulator's QuickJS, which the host creates (`pebblePhoneHost.pkjs`), one per
 * app, isolated from the page. Calls from the app's JS into Kotlin and back are
 * synchronous on this one thread.
 *
 * `XMLHttpRequest` and `WebSocket` are upstream's classes and managers (the WebSocket
 * manager ported from iOS); their requests go to the page's phone network, which
 * follows the session's network setting and CORS, as the built-in phone's do.
 * Not in the browser: synchronous XHR (the one thread cannot wait for the network; the
 * app's `send` throws), and intercepted HTTP responses (as on iOS).
 */
class BrowserJsRunner(
    private val appContext: AppContext,
    private val libPebble: LibPebble,
    private val jsTokenUtil: JsTokenUtil,
    device: CompanionAppDevice,
    private val scope: CoroutineScope,
    appInfo: PbwAppInfo,
    lockerEntry: LockerEntry,
    jsPath: Path,
    urlOpenRequests: Channel<String>,
    private val logMessages: Channel<String>,
    private val remoteTimelineEmulator: RemoteTimelineEmulator,
    private val httpInterceptorManager: HttpInterceptorManager,
    private val notificationConfigFlow: NotificationConfigFlow,
    private val pluginRegistry: PluginRegistry,
) : JsRunner(appInfo, lockerEntry, jsPath, device, urlOpenRequests) {
    private val logger = Logger.withTag("BrowserJsRunner-${appInfo.longName}")
    private var engine: JsAny? = null
    private val interfaces = mutableMapOf<String, JsEngineInterface>()
    private val httpEngine = HostHttpEngine()
    private val httpClient = HttpClient(httpEngine) {}

    /** Statements for the engine to run when the current native call returns. */
    private val afterCall = mutableListOf<String>()

    override fun debugForceGC() = Unit

    override suspend fun start() {
        engine = pkjsCreate("PKJS: ${appInfo.longName}", ::dispatchFromJs)
        registerInterfaces()
        evalNow("globalThis.navigator = { userAgent: 'PKJS', geolocation: {}, language: 'en-US' };", "navigator.js")
        evalNow(BASE64_JS, "base64.js")
        evalNow(XML_HTTP_REQUEST_JS, "xmlhttprequest.js")
        evalNow(PKJS_WEBSOCKET_JS, "WebSocket.js")
        evalNow(PKJS_TIMEOUT_JS, "JSTimeout.js")
        evalNow(PKJS_STARTUP_JS, "startup.js")
        loadAppJs(jsPath.toString())
    }

    private fun registerInterfaces() {
        // Arguments cross as JSON. Typed arrays and ArrayBuffers go as {"__bytes": base64},
        // which the dispatcher turns back into a ByteArray, as JavaScriptCore could not and
        // upstream's XMLHTTPRequestManager.send accepts.
        evalNow(
            """
            Object.defineProperty(globalThis, '__bridgeValue', { value: function (key, value) {
                if (value instanceof ArrayBuffer) value = new Uint8Array(value);
                else if (ArrayBuffer.isView(value))
                    value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                else return value;
                return { __bytes: value.toBase64() };
            } });
            """.trimIndent(),
            "bridge.js",
        )
        val privateInterface = JSCPrivatePKJSInterface(
            jsPath, this, device, scope, _outgoingAppMessages, logMessages, jsTokenUtil,
            remoteTimelineEmulator, httpInterceptorManager, notificationConfigFlow, pluginRegistry,
        )
        val instances = listOf(
            XMLHTTPRequestManager(
                scope = scope,
                eval = { evalNow(it, "xhr") },
                httpInterceptorManager = httpInterceptorManager,
                appUuid = Uuid.parse(appInfo.uuid),
                client = httpClient,
            ),
            BrowserWebSocketManager(scope) { evalNow(it, "websocket") },
            BrowserTimeout(scope) { evalNow(it, "timer") },
            JSCPKJSInterface(this, device, libPebble, jsTokenUtil),
            BrowserAppMessages(privateInterface),
            BrowserLocalStorage(appInfo.uuid, appContext) { afterCall += it },
            JSCGeolocationInterface(scope, this),
        )
        for (iface in instances) {
            interfaces[iface.name] = iface
            val methods = iface.methods.joinToString(",") { Json.encodeToString(it) }
            // Pure JS proxies, as on iOS; each call crosses as JSON.
            evalNow(
                """
                var ${iface.name} = globalThis.${iface.name} = {};
                [$methods].forEach(function (m) {
                    ${iface.name}[m] = function () {
                        var r = JSON.parse(__nativeDispatch('${iface.name}', m, JSON.stringify(Array.from(arguments), __bridgeValue)));
                        if (r.x) (0, eval)(r.x);
                        if ('e' in r) throw new Error(r.e);
                        return r.v;
                    };
                });
                """.trimIndent(),
                "${iface.name}.js",
            )
        }
        evalNow("localStorage.length = ${(interfaces["localStorage"] as BrowserLocalStorage).getLength()}; localStorage.__override__ = true;", "localStorage.js")
    }

    /** One call from the app's JS: arguments and result cross as JSON. */
    private fun dispatchFromJs(objectName: String, method: String, argsJson: String): String {
        val result = try {
            val iface = interfaces[objectName] ?: error("No interface $objectName")
            val args = (Json.parseToJsonElement(argsJson) as JsonArray).map { it.toKotlin() }
            buildJsonObject { put("v", iface.dispatch(method, args).toJson()) }
        } catch (e: Throwable) {
            logger.e(e) { "$objectName.$method failed" }
            buildJsonObject { put("e", "$objectName.$method: ${e.message}") }
        }
        val after = afterCall.joinToString("\n").also { afterCall.clear() }
        return if (after.isEmpty()) result.toString()
        else JsonObject(result + ("x" to JsonPrimitive(after))).toString()
    }

    /** Runs [code] now; an exception in it is the app's, logged as iOS logs it. */
    private fun evalNow(code: String, fileName: String): Any? {
        val current = engine ?: return null
        val outcome = Json.parseToJsonElement(pkjsEval(current, code, fileName)) as JsonObject
        outcome["e"]?.let {
            logger.e { "JS Exception in $fileName: ${(it as JsonPrimitive).content}" }
            return null
        }
        return outcome["v"]?.toKotlin()
    }

    override suspend fun stop() {
        _readyState.value = false
        scope.cancel()
        interfaces.values.forEach { (it as? AutoCloseable)?.close() }
        interfaces.clear()
        httpClient.close()
        httpEngine.close()
        engine?.let { pkjsDestroy(it) }
        engine = null
    }

    override suspend fun loadAppJs(jsUrl: String) {
        val js = SystemFileSystem.source(Path(jsUrl)).buffered().use { it.readString() }
        evalNow(js, "pebble-js-app.js")
        signalReady()
    }

    override suspend fun signalInterceptResponse(callbackId: String, result: InterceptResponse) =
        error("Intercepted HTTP responses are not supported by the browser runner (nor on iOS)")

    override suspend fun signalNewAppMessageData(data: String?): Boolean {
        evalNow("globalThis.signalNewAppMessageData(${Json.encodeToString(data)})", "appmessage")
        return true
    }

    override suspend fun signalTimelineToken(callId: String, token: String) {
        val tokenJson = Json.encodeToString(mapOf("userToken" to token, "callId" to callId))
        evalNow("globalThis.signalTimelineTokenSuccess($tokenJson)", "timeline")
    }

    override suspend fun signalTimelineTokenFail(callId: String) {
        val tokenJson = Json.encodeToString(mapOf("userToken" to null, "callId" to callId))
        evalNow("globalThis.signalTimelineTokenFailure($tokenJson)", "timeline")
    }

    override suspend fun signalReady() {
        evalNow("globalThis.signalReady()", "ready")
    }

    override suspend fun signalShowConfiguration() {
        evalNow("globalThis.signalShowConfiguration()", "configuration")
    }

    override suspend fun signalWebviewClosed(data: String?) {
        evalNow("globalThis.signalWebviewClosedEvent(${Json.encodeToString(data)})", "configuration")
    }

    override suspend fun signalConfigMessage(requestId: Int, json: String) {
        evalNow("globalThis.signalConfigMessageEvent($requestId, $json)", "configuration")
    }

    override suspend fun eval(js: String) {
        evalNow(js, "eval")
    }

    override suspend fun evalWithResult(js: String): Any? = evalNow(js, "eval")

    /**
     * Upstream's private interface, except that `sendAppMessageString` does not block for
     * the watch's transaction ID, which a browser thread cannot wait for (upstream uses
     * `runBlocking`). It returns a local ID at once, and the watch's own ACK or NACK is
     * delivered under that ID later: all `startup.js` uses the ID for is matching them.
     */
    private inner class BrowserAppMessages(
        private val upstream: JSCPrivatePKJSInterface,
    ) : JsEngineInterface by upstream, AutoCloseable {
        private var nextId = 0

        override fun dispatch(method: String, args: List<Any?>): Any? =
            if (method == "sendAppMessageString") sendAppMessage(args[0].toString())
            else upstream.dispatch(method, args)

        private fun sendAppMessage(json: String): Int {
            val id = nextId
            nextId = (nextId + 1) % 256
            val request = AppMessageRequest(json)
            val job = scope.launch {
                val done = request.state.first {
                    it is AppMessageRequest.State.Sent || it is AppMessageRequest.State.DataError
                }
                val ack = done is AppMessageRequest.State.Sent && done.result is AppMessageResult.ACK
                val payload = Json.encodeToString(
                    Json.encodeToString(
                        buildJsonObject {
                            put("data", buildJsonObject { put("transactionId", id) })
                            if (!ack) put("error", "nack")
                        },
                    ),
                )
                evalNow("${if (ack) "signalAppMessageAck" else "signalAppMessageNack"}($payload)", "appmessage")
            }
            if (!_outgoingAppMessages.tryEmit(request)) {
                logger.e { "Failed to emit outgoing AppMessage" }
                job.cancel()
                return -1
            }
            return id
        }

        override fun close() = upstream.close()
    }
}

/** Timers for the app's JS (upstream's JSTimeout.js), run by the phone's coroutines. */
private class BrowserTimeout(
    private val scope: CoroutineScope,
    private val eval: (String) -> Any?,
) : RegisterableJsInterface {
    private val timers = mutableMapOf<Int, Job>()
    private var nextId = 1
    override val name = "_Timeout"
    override val interf = mapOf(
        "setTimeout" to Unit,
        "setInterval" to Unit,
        "clearTimeout" to Unit,
        "clearInterval" to Unit,
    )

    override fun dispatch(method: String, args: List<Any?>): Any? = when (method) {
        "setTimeout" -> schedule((args[0] as Number).toDouble(), repeat = false)
        "setInterval" -> schedule((args[0] as Number).toDouble(), repeat = true)
        "clearTimeout", "clearInterval" -> {
            timers.remove((args[0] as Number).toInt())?.cancel()
            null
        }
        else -> error("Unknown method: $method")
    }

    private fun schedule(delayMs: Double, repeat: Boolean): Double {
        val id = nextId++
        timers[id] = scope.launch {
            do {
                delay(delayMs.milliseconds)
                if (!isActive) break
                if (!repeat) timers.remove(id)
                eval(if (repeat) "globalThis._LibPebbleTriggerInterval($id)" else "globalThis._LibPebbleTriggerTimeout($id)")
            } while (repeat && isActive)
        }
        return id.toDouble()
    }

    override fun close() {
        timers.values.forEach { it.cancel() }
        timers.clear()
    }
}

/** `localStorage` for the app's JS, in the session's memory (createJSSettings). */
private class BrowserLocalStorage(
    uuid: String,
    appContext: AppContext,
    private val afterCall: (String) -> Unit,
) : JSLocalStorageInterface(uuid, appContext), RegisterableJsInterface {
    override val name = "localStorage"
    override val interf = mapOf(
        "getItem" to Unit,
        "setItem" to Unit,
        "removeItem" to Unit,
        "clear" to Unit,
        "key" to Unit,
    )

    override fun dispatch(method: String, args: List<Any?>): Any? = when (method) {
        "getItem" -> getItem(args.getOrNull(0))
        "setItem" -> { setItem(args.getOrNull(0), args.getOrNull(1)); null }
        "removeItem" -> { removeItem(args.getOrNull(0)); null }
        "clear" -> { clear(); null }
        "key" -> key((args[0] as Number).toDouble())
        else -> error("Unknown method: $method")
    }

    override fun setLength(value: Int) = afterCall("localStorage.length = $value;")

    override fun close() = Unit
}

private fun JsonElement.toKotlin(): Any? = when (this) {
    JsonNull -> null
    is JsonPrimitive -> if (isString) content else booleanOrNull ?: doubleOrNull ?: content
    is JsonArray -> map { it.toKotlin() }
    is JsonObject -> (this["__bytes"] as? JsonPrimitive)?.takeIf { size == 1 }?.let { Base64.decode(it.content) }
        ?: mapValues { it.value.toKotlin() }
}

private fun Any?.toJson(): JsonElement = when (this) {
    null, Unit -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { it.key.toString() to it.value.toJson() })
    is List<*> -> JsonArray(map { it.toJson() })
    else -> JsonPrimitive(toString())
}

private fun pkjsCreate(label: String, dispatch: (String, String, String) -> String): JsAny =
    js("globalThis.pebblePhoneHost.pkjs.create(label, dispatch)")

private fun pkjsEval(engine: JsAny, code: String, fileName: String): String =
    js("engine.eval(code, fileName)")

private fun pkjsDestroy(engine: JsAny): Unit = js("{ engine.destroy(); }")
