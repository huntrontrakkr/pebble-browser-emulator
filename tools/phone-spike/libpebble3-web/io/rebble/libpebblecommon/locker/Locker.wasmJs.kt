package io.rebble.libpebblecommon.locker

import io.rebble.libpebblecommon.connection.AppContext
import kotlinx.io.files.Path

// Browser phone paths live in its in-memory file system, discarded with the session.
actual fun getLockerPBWCacheDirectory(context: AppContext): Path = Path("/locker/pbw")

actual fun getLockerPBWCacheLegacyDirectory(context: AppContext): Path? = null
