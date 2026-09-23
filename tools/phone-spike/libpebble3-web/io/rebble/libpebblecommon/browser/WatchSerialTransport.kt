package io.rebble.libpebblecommon.browser

import co.touchlab.kermit.Logger
import io.ktor.utils.io.writeByteArray
import io.rebble.libpebblecommon.connection.ConnectionFailureReason
import io.rebble.libpebblecommon.connection.KnownWatchProperties
import io.rebble.libpebblecommon.connection.PebbleConnectionResult
import io.rebble.libpebblecommon.connection.PebbleProtocolStreams
import io.rebble.libpebblecommon.connection.TransportConnector
import io.rebble.libpebblecommon.connection.qemu.QemuFrameParser
import io.rebble.libpebblecommon.connection.qemu.QemuFraming
import io.rebble.libpebblecommon.di.ConnectionCoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.launch

/**
 * Upstream's QEMU transport with the emulator's serial channel in place of a TCP socket:
 * the same framing (upstream's [QemuFraming] and [QemuFrameParser]), the same
 * CommSession-open frame, and Pebble Protocol in SPP frames. The host moves raw serial
 * bytes between this and the emulated watch's Pebble Protocol UART.
 */
internal class WatchSerialTransport(
    private val pebbleProtocolStreams: PebbleProtocolStreams,
    private val connectionCoroutineScope: ConnectionCoroutineScope,
) : TransportConnector {
    private val logger = Logger.withTag("WatchSerialTransport")
    private val _disconnected = CompletableDeferred<ConnectionFailureReason>()
    private val inbound = Channel<ByteArray>(Channel.UNLIMITED)

    override suspend fun connect(
        knownWatchProperties: KnownWatchProperties?,
        lastError: ConnectionFailureReason?,
    ): PebbleConnectionResult {
        if (!WatchSerialLink.attach(this)) {
            logger.w { "no serial link to the emulated watch" }
            return PebbleConnectionResult.Failed(ConnectionFailureReason.SocketConnectionFailed)
        }
        // The firmware discards SPP data unless a CommSession is open.
        WatchSerialLink.write(QemuFraming.frame(QemuFraming.PROTOCOL_BLUETOOTH_CONNECTION, byteArrayOf(1)))
        connectionCoroutineScope.launch { readLoop() }
        connectionCoroutineScope.launch { writeLoop() }
        return PebbleConnectionResult.Success(null)
    }

    /** Serial bytes from the watch, in order; called on the host's turn. */
    fun received(bytes: ByteArray) {
        inbound.trySend(bytes)
    }

    /** The host closed the link: the read loop ends and upstream sees the disconnection. */
    fun linkClosed() {
        inbound.close()
    }

    private suspend fun readLoop() {
        val parser = QemuFrameParser()
        try {
            for (bytes in inbound) {
                for (frame in parser.feed(bytes)) {
                    if (frame.protocol != QemuFraming.PROTOCOL_SPP) continue
                    pebbleProtocolStreams.inboundPPBytes.writeByteArray(frame.payload)
                    pebbleProtocolStreams.inboundPPBytes.flush()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.w(e) { "read loop ended" }
        } finally {
            cleanup()
        }
    }

    private suspend fun writeLoop() {
        try {
            pebbleProtocolStreams.outboundPPBytes.consumeAsFlow().collect { bytes ->
                var offset = 0
                while (offset < bytes.size) {
                    val end = minOf(offset + QemuFraming.MAX_DATA_LEN, bytes.size)
                    WatchSerialLink.write(QemuFraming.frame(QemuFraming.PROTOCOL_SPP, bytes.copyOfRange(offset, end)))
                    offset = end
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.w(e) { "write loop ended" }
        } finally {
            cleanup()
        }
    }

    /** Idempotent, as upstream's: whichever loop ends first detaches the link. */
    private fun cleanup() {
        _disconnected.complete(ConnectionFailureReason.SocketDisconnected)
        inbound.close()
        WatchSerialLink.detach(this)
    }

    override suspend fun disconnect() = cleanup()

    override val disconnected: Deferred<ConnectionFailureReason> = _disconnected
}

/**
 * The page's one serial link to the emulated watch. The host installs it by calling
 * [phoneAttachWatch]; at most one connection uses it at a time, as with a socket to QEMU.
 */
internal object WatchSerialLink {
    private var host: JsAny? = null
    private var transport: WatchSerialTransport? = null

    fun install(sink: JsAny?) {
        host = sink
        if (sink == null) transport?.linkClosed()
    }

    fun attach(connection: WatchSerialTransport): Boolean {
        if (host == null || transport != null) return false
        transport = connection
        return true
    }

    fun detach(connection: WatchSerialTransport) {
        if (transport === connection) transport = null
    }

    fun write(bytes: ByteArray) {
        val sink = host ?: error("The serial link to the emulated watch is closed")
        callSink(sink, bytes.toUint8Array())
    }

    /** Returns false when no connection is reading, so the host can report dropped bytes. */
    fun received(bytes: ByteArray): Boolean {
        val connection = transport ?: return false
        connection.received(bytes)
        return true
    }
}

internal fun ByteArray.toUint8Array(): JsAny {
    val array = newUint8Array(size)
    for (i in indices) setUint8(array, i, this[i].toInt() and 0xff)
    return array
}

internal fun JsAny.uint8ArrayToByteArray(): ByteArray = ByteArray(uint8Length(this)) { getUint8(this, it).toByte() }

private fun callSink(sink: JsAny, bytes: JsAny): Unit = js("{ sink(bytes); }")
private fun newUint8Array(size: Int): JsAny = js("new Uint8Array(size)")
private fun setUint8(array: JsAny, index: Int, value: Int): Unit = js("{ array[index] = value; }")
private fun getUint8(array: JsAny, index: Int): Int = js("array[index]")
private fun uint8Length(array: JsAny): Int = js("array.length")
