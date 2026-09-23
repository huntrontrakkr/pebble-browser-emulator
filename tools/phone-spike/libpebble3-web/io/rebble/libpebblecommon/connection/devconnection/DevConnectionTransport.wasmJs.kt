package io.rebble.libpebblecommon.connection.devconnection

import kotlinx.io.files.Path

internal actual fun getTempPbwPath(): Path = Path("/tmp", "devconnection.pbw")
