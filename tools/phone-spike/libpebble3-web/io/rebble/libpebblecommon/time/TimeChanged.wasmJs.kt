package io.rebble.libpebblecommon.time

import io.rebble.libpebblecommon.connection.AppContext

/**
 * A browser has no time-change broadcast. The emulator owns the watch's clock, so a
 * change to it will be reported here when the host models one; until then nothing fires.
 */
actual fun createTimeChanged(appContext: AppContext): TimeChanged = object : TimeChanged {
    override fun registerForTimeChanges(onChanged: () -> Unit) = Unit
}
