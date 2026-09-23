package io.rebble.libpebblecommon.util

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

// Shared code imports these in place of kotlinx.coroutines' runBlocking and
// Dispatchers.IO, which the browser does not have. Android, desktop and iOS
// delegate to kotlinx.coroutines unchanged.

/** Runs [block] to completion on the calling thread. */
internal expect fun <T> runBlocking(
    context: CoroutineContext = EmptyCoroutineContext,
    block: suspend CoroutineScope.() -> T,
): T

/** The dispatcher for blocking I/O. */
internal expect val Dispatchers.IO: CoroutineDispatcher
