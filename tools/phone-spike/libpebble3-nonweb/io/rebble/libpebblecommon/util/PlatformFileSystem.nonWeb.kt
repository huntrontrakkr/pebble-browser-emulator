package io.rebble.libpebblecommon.util

import okio.FileSystem
import okio.Path
import okio.SYSTEM as OkioSystem
import okio.openZip as okioOpenZip

internal actual val FileSystem.Companion.SYSTEM: FileSystem
    get() = FileSystem.OkioSystem

internal actual fun FileSystem.openZip(zipPath: Path): FileSystem = okioOpenZip(zipPath)
