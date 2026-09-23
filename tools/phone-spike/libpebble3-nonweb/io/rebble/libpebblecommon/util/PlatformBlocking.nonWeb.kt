package io.rebble.libpebblecommon.util

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.IO as KotlinxIO

internal actual fun <T> runBlocking(
    context: CoroutineContext,
    block: suspend CoroutineScope.() -> T,
): T = kotlinx.coroutines.runBlocking(context, block)

internal actual val Dispatchers.IO: CoroutineDispatcher
    get() = Dispatchers.KotlinxIO
