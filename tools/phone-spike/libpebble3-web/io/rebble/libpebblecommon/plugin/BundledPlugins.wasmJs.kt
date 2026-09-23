package io.rebble.libpebblecommon.plugin

import io.rebble.libpebblecommon.connection.AppContext

// The browser phone ships no bundled apps or plugin files, as on desktop.
actual fun readBundledApp(appContext: AppContext, fileName: String): ByteArray? = null

actual fun readBundledPluginFile(appContext: AppContext, pluginDir: String, fileName: String): String? = null
