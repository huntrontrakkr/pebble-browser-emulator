@file:OptIn(ExperimentalJsExport::class)

package io.rebble.libpebblecommon.browser

import com.russhwolf.settings.Settings
import io.ktor.http.decodeURLPart
import io.rebble.libpebblecommon.LibPebbleConfig
import io.rebble.libpebblecommon.metadata.WatchType
import io.rebble.libpebblecommon.connection.AppContext
import io.rebble.libpebblecommon.connection.ConnectedPebbleDevice
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.promise
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlin.js.Promise
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

/**
 * The platform LibPebble assumes for a watch whose hardware revision it does not list
 * (upstream's `WatchConfig.unknownWatchTypePlatform`, which defaults to Emery). The QEMU
 * emulator firmware reports a revision LibPebble does not list, so the host names the
 * emulated profile's platform by codename ("emery", "flint", "gabbro") before connecting.
 */
@JsExport
fun phoneSetUnknownWatchPlatform(codename: String): String = report {
    val libPebble = phone ?: error("The phone has not started")
    val type = WatchType.entries.firstOrNull { it.codename == codename } ?: error("No platform $codename")
    val current = libPebble.config.value
    libPebble.updateConfig(current.copy(watchConfig = current.watchConfig.copy(unknownWatchTypePlatform = type)))
}

/** Adds the emulated watch and asks LibPebble's watch manager to connect to it. */
@JsExport
fun phoneConnectWatch(): String = report {
    val libPebble = phone ?: error("The phone has not started")
    libPebble.addQemuWatch(EMULATED_WATCH, connect = true)
}

/** Where sideloaded bundles are written before LibPebble reads them. */
private val SIDELOAD_DIRECTORY = Path("/sideload")

private val hostCalls = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * Installs an app bundle (`Uint8Array`) as the phone app's sideload does: the bundle is
 * written to the phone's in-memory files and passed to LibPebble's `sideloadApp`, which
 * adds it to the locker, syncs it to each connected watch and launches it there. The
 * promise resolves to an empty string, or why the install failed.
 */
@JsExport
fun phoneInstall(bytes: JsAny, fileName: String): Promise<JsAny?> {
    val bundle = bytes.uint8ArrayToByteArray()
    return hostCalls.promise {
        try {
            val libPebble = phone ?: error("The phone has not started")
            SystemFileSystem.createDirectories(SIDELOAD_DIRECTORY)
            val path = Path(SIDELOAD_DIRECTORY, fileName.substringAfterLast('/').ifBlank { "app.pbw" })
            SystemFileSystem.sink(path).buffered().use { it.write(bundle) }
            if (libPebble.sideloadApp(path, loadOnWatch = true)) "" else "LibPebble reported the sideload as failed"
        } catch (e: Throwable) {
            e.stackTraceToString()
        }.toJsString()
    }
}

/**
 * The app the connected watch reports running (AppRunState), as LibPebble tracks it,
 * or an empty string with no connected watch or no report yet.
 */
@JsExport
fun phoneRunningApp(): String =
    phone?.watches?.value?.filterIsInstance<ConnectedPebbleDevice>()?.firstOrNull()?.runningApp?.value?.toString() ?: ""

/** The running app's PebbleKit JS session on the connected watch, as the phone app finds it. */
private fun currentPkjsSession() = phone?.watches?.value
    ?.filterIsInstance<ConnectedPebbleDevice>()
    ?.firstOrNull { it.currentPKJSSession.value != null }
    ?.currentPKJSSession?.value

/**
 * Opens the running app's configuration as the phone app's settings button does: the
 * app's PebbleKit JS handles `showConfiguration` and names a URL. Resolves to that URL,
 * or an empty string with no PebbleKit JS session or no URL.
 */
@JsExport
fun phoneRequestConfiguration(): Promise<JsAny?> = hostCalls.promise {
    try {
        currentPkjsSession()?.requestConfigurationUrl() ?: ""
    } catch (e: Throwable) {
        e.stackTraceToString()
    }.toJsString()
}

/**
 * The configuration page closed at [url] (`pebblejs://close#<data>`, or the legacy `/?`
 * and `/` forms). Delivers the data to the app's PebbleKit JS as the phone app's settings
 * screen does (WatchappSettingsScreen's interceptor): the part after the prefix,
 * URL-decoded. Returns an empty string, or why nothing was delivered.
 */
@JsExport
fun phoneConfigurationClosed(url: String): String {
    val match = Regex("""^pebblejs://close(?:#|/\?|/)(.*)$""").find(url)
        ?: return "Not a configuration close URL: $url"
    val data = match.groupValues[1].decodeURLPart()
    if (data.isEmpty()) return "The page closed without data"
    val session = currentPkjsSession() ?: return "No PebbleKit JS session is running"
    session.triggerOnWebviewClosed(data)
    return ""
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
