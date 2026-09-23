package io.rebble.libpebblecommon.util

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext

/**
 * The browser has one thread and cannot block. [block] runs immediately and must
 * finish without suspending, which holds for the phone's in-memory database: its
 * SQLite runs synchronously in the same thread. A block that would wait on other
 * work fails here instead of deadlocking; the browser adapters override those paths
 * (the PebbleKit JS bridge answers asynchronously).
 */
internal actual fun <T> runBlocking(
    context: CoroutineContext,
    block: suspend CoroutineScope.() -> T,
): T {
    var outcome: Result<T>? = null
    val job = CoroutineScope(context + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
        outcome = runCatching { block() }
    }
    outcome?.let { return it.getOrThrow() }
    job.cancel()
    error("A blocking call suspended; the browser cannot wait for it on its single thread")
}

/** Blocking I/O in the browser is the in-memory database, which runs inline. */
internal actual val Dispatchers.IO: CoroutineDispatcher
    get() = Dispatchers.Unconfined
