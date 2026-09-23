package kotlinx.io

// The browser phone is an Android phone: POSIX paths and line endings whatever the
// host's own OS (the released build asks `navigator.platform`).

internal actual fun withCaughtException(block: () -> Unit): Throwable? =
    try {
        block()
        null
    } catch (e: Throwable) {
        e
    }

public actual val SystemLineSeparator: String = "\n"

internal actual val isWindows: Boolean = false
