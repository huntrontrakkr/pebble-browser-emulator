package io.rebble.libpebblecommon.js

import com.russhwolf.settings.Settings
import io.rebble.libpebblecommon.browser.MemorySettings
import io.rebble.libpebblecommon.connection.AppContext

/** PebbleKit JS `localStorage`, per app, for the session only. */
private val appStorage = mutableMapOf<String, Settings>()

internal actual fun createJSSettings(appContext: AppContext, id: String): Settings =
    appStorage.getOrPut(id) { MemorySettings() }
