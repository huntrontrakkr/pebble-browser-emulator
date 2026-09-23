package io.rebble.libpebblecommon.util

import okio.FileSystem
import okio.Path

// Shared code imports these in place of Okio's FileSystem.SYSTEM and openZip, which
// Okio's browser build does not have. Android, desktop and iOS delegate to Okio
// unchanged.

/** The file system app bundles (PBW, PBZ) are stored in. */
internal expect val FileSystem.Companion.SYSTEM: FileSystem

/** A read-only view of the zip archive at [zipPath]. */
internal expect fun FileSystem.openZip(zipPath: Path): FileSystem
