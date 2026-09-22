package io.rebble.libpebblecommon.database

import androidx.room.Room
import androidx.room.RoomDatabase
import io.rebble.libpebblecommon.connection.AppContext

// The browser phone is a test fixture discarded with the session, so its database
// lives in memory. Browser adapter for the spike; not part of upstream.
internal actual fun getDatabaseBuilder(ctx: AppContext): RoomDatabase.Builder<Database> =
    Room.inMemoryDatabaseBuilder<Database>()
