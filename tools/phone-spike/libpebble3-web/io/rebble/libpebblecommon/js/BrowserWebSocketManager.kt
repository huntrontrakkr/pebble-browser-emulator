package io.rebble.libpebblecommon.js

import co.touchlab.kermit.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * `_WebSocketManager` in the browser: upstream's iOS manager (WebSocketManager.kt) with the
 * page's phone network (`pebblePhoneHost.network`, libpebble-network.ts) in place of ktor's
 * Darwin client. The app's `WebSocket` class is upstream's WebSocket.js, unchanged, and it
 * receives the same calls: `_onOpen`, `_onMessage` (binary as base64), `_onError`, `_onClose`.
 * Events reach the app from the phone's coroutines, never inside the app's own call.
 */
internal class BrowserWebSocketManager(
    private val scope: CoroutineScope,
    private val eval: (String) -> Any?,
) : RegisterableJsInterface {
    private val logger = Logger.withTag("BrowserWebSocketManager")
    private val open = mutableSetOf<Int>()

    override val name = "_WebSocketManager"
    override val interf = mapOf(
        "createInstance" to Unit,
        "send" to Unit,
        "close" to Unit,
    )

    override fun dispatch(method: String, args: List<Any?>): Any? = when (method) {
        "createInstance" -> createInstance(args[0].toString(), args.getOrNull(1)?.toString().orEmpty())
        "send" -> {
            send((args[0] as Number).toInt(), args[1].toString(), args.getOrNull(2) as? Boolean ?: false)
            null
        }
        "close" -> {
            closeInstance(
                (args[0] as Number).toInt(),
                (args.getOrNull(1) as? Number)?.toInt() ?: 1000,
                args.getOrNull(2)?.toString() ?: "",
            )
            null
        }
        else -> error("Unknown method: $method")
    }

    private fun createInstance(url: String, protocols: String): Int {
        var id = 0
        id = hostOpenSocket(url, protocols) { json -> scope.launch { deliver(id, json) } }
        open += id
        return id
    }

    private fun deliver(id: Int, json: String) {
        val event = Json.parseToJsonElement(json).jsonObject
        val instance = "WebSocket._instances.get($id)"
        when (event["type"]?.jsonPrimitive?.content) {
            "open" -> eval("$instance._onOpen(${event["protocol"] ?: "\"\""})")
            "message" -> {
                val text = event["text"]
                if (text != null) eval("$instance._onMessage($text, false)")
                else eval("$instance._onMessage(${event["base64"]}, true)")
            }
            "error" -> {
                logger.e { "WebSocket error for instance $id: ${event["message"]?.jsonPrimitive?.content}" }
                eval("$instance._onError()")
            }
            "close" -> {
                open -= id
                val code = event["code"]?.jsonPrimitive?.int ?: 1006
                val reason = event["reason"] ?: JsonPrimitive("")
                val clean = event["wasClean"]?.jsonPrimitive?.boolean ?: false
                eval("$instance._onClose($code, $reason, $clean)")
            }
        }
    }

    private fun send(id: Int, data: String, isBinary: Boolean) {
        if (id !in open) {
            logger.w { "send called on unknown instance $id" }
            return
        }
        hostSendSocket(id, data, isBinary)
    }

    private fun closeInstance(id: Int, code: Int, reason: String) {
        if (id !in open) {
            logger.w { "close called on unknown instance $id" }
            return
        }
        hostCloseSocket(id, code, reason)
    }

    override fun close() {
        for (id in open.toList()) hostCloseSocket(id, 1000, "")
        open.clear()
    }
}

private fun hostOpenSocket(url: String, protocols: String, event: (String) -> Unit): Int =
    js("globalThis.pebblePhoneHost.network.openSocket(url, protocols, event)")

private fun hostSendSocket(id: Int, data: String, binary: Boolean): Unit =
    js("{ globalThis.pebblePhoneHost.network.sendSocket(id, data, binary); }")

private fun hostCloseSocket(id: Int, code: Int, reason: String): Unit =
    js("{ globalThis.pebblePhoneHost.network.closeSocket(id, code, reason); }")
