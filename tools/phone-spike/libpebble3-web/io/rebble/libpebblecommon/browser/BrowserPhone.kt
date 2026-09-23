@file:OptIn(ExperimentalJsExport::class)

package io.rebble.libpebblecommon.browser

import com.russhwolf.settings.Settings
import io.rebble.libpebblecommon.LibPebbleConfig
import io.rebble.libpebblecommon.connection.AppContext
import io.rebble.libpebblecommon.connection.FirmwareUpdateCheckResult
import io.rebble.libpebblecommon.connection.LibPebble
import io.rebble.libpebblecommon.connection.PebbleIdentifier
import io.rebble.libpebblecommon.connection.PebbleSocketIdentifier
import io.rebble.libpebblecommon.connection.TokenProvider
import io.rebble.libpebblecommon.connection.TransportConnector
import io.rebble.libpebblecommon.connection.WebServices
import io.rebble.libpebblecommon.di.ConnectionScope
import io.rebble.libpebblecommon.di.initKoin
import io.rebble.libpebblecommon.js.InjectedPKJSHttpInterceptors
import io.rebble.libpebblecommon.services.WatchInfo
import io.rebble.libpebblecommon.voice.TranscriptionProvider
import io.rebble.libpebblecommon.voice.TranscriptionResult
import io.rebble.libpebblecommon.voice.VoiceEncoderInfo
import io.rebble.libpebblecommon.web.LockerModelWrapper
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import org.koin.dsl.module
import kotlin.uuid.Uuid

// The browser entry point: starts upstream's LibPebble in the page (or the phone worker)
// and connects it to the emulated watch over the emulator's serial link. The host
// publishes `globalThis.sqlite3` (SQLite Wasm) and `globalThis.fflate` first.

/** The address of the emulated watch; only the serial transport below reads it. */
private const val EMULATED_WATCH = "emulator:0"

private var phone: LibPebble? = null

/**
 * Starts the phone as `LibPebble.create` does, with two session-only substitutions made
 * after upstream's bindings load and before anything reads them: settings live in memory,
 * and a watch at a socket address is reached over the serial link. Returns an empty
 * string, or why the phone could not start.
 */
@JsExport
fun phoneStart(): String = report {
    if (phone != null) return@report
    val koin = initKoin(
        defaultConfig = LibPebbleConfig(),
        webServices = NoAccountWebServices,
        appContext = AppContext(),
        tokenProvider = NoDeveloperToken,
        proxyTokenProvider = MutableStateFlow(null),
        transcriptionProvider = NoTranscription,
        injectedPKJSHttpInterceptors = InjectedPKJSHttpInterceptors(emptyList()),
    )
    koin.loadModules(
        listOf(
            module {
                single<Settings> { MemorySettings() }
                scope<ConnectionScope> {
                    scoped<TransportConnector> {
                        when (val id = get<PebbleIdentifier>()) {
                            is PebbleSocketIdentifier -> WatchSerialTransport(get(), get())
                            else -> error("The browser phone reaches watches only over the emulator's serial link: $id")
                        }
                    }
                }
            },
        ),
        allowOverride = true,
    )
    // LibPebble.create also configures Kable's central here, which is iOS-only.
    phone = koin.get<LibPebble>().also { it.init() }
}

/**
 * Installs the serial link to the emulated watch: [sink] is a JavaScript function that
 * receives each `Uint8Array` for the watch's Pebble Protocol UART. `null` closes it.
 */
@JsExport
fun phoneAttachSerial(sink: JsAny?) = WatchSerialLink.install(sink)

/** Serial bytes (`Uint8Array`) from the watch; false when no connection is reading them. */
@JsExport
fun phoneSerialFromWatch(bytes: JsAny): Boolean = WatchSerialLink.received(bytes.uint8ArrayToByteArray())

/** Adds the emulated watch and asks LibPebble's watch manager to connect to it. */
@JsExport
fun phoneConnectWatch(): String = report {
    val libPebble = phone ?: error("The phone has not started")
    libPebble.addQemuWatch(EMULATED_WATCH, connect = true)
}

/** LibPebble's own description of its watches and their connection state. */
@JsExport
fun phoneStatus(): String = phone?.watchesDebugState() ?: "not started"

private inline fun report(block: () -> Unit): String =
    try {
        block()
        ""
    } catch (e: Throwable) {
        e.stackTraceToString()
    }

/** No Pebble account: no locker, no firmware-update service, no uploads. */
private object NoAccountWebServices : WebServices {
    override suspend fun fetchLocker(): LockerModelWrapper? = null
    override suspend fun removeFromLocker(id: Uuid): Boolean = false
    override suspend fun checkForFirmwareUpdate(watch: WatchInfo, force: Boolean): FirmwareUpdateCheckResult =
        FirmwareUpdateCheckResult.UpdateCheckFailed("The browser phone has no firmware-update service")
    override fun uploadMemfaultChunk(chunk: ByteArray, watchInfo: WatchInfo) = Unit
    override fun uploadAnalyticsHeartbeat(payload: ByteArray, watchInfo: WatchInfo) = Unit
}

private object NoDeveloperToken : TokenProvider {
    override suspend fun getDevToken(): String? = null
}

private object NoTranscription : TranscriptionProvider {
    override suspend fun transcribe(
        encoderInfo: VoiceEncoderInfo,
        audioFrames: Flow<UByteArray>,
        isNotificationReply: Boolean,
    ): TranscriptionResult = TranscriptionResult.Disabled
    override suspend fun canServeSession(): Boolean = false
}
