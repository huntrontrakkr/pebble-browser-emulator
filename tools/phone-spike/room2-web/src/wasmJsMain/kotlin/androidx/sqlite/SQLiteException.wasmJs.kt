// Browser (wasmJs) counterpart of a Room 2.8.4 nativeMain file, adapted from the
// released androidx sources jar (Apache License 2.0, The Android Open Source Project).
package androidx.sqlite

import androidx.annotation.RestrictTo

public actual class SQLiteException
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
actual constructor(message: String) : RuntimeException(message)
