// Browser (wasmJs) counterpart of a Room 2.8.4 nativeMain file, adapted from the
// released androidx sources jar (Apache License 2.0, The Android Open Source Project).
package androidx.room

import androidx.room.util.findDatabaseConstructorAndInitDatabaseImpl

public actual object Room {
    public actual const val MASTER_TABLE_NAME: String = RoomMasterTable.TABLE_NAME

    public inline fun <reified T : RoomDatabase> inMemoryDatabaseBuilder(
        noinline factory: () -> T = { findDatabaseConstructorAndInitDatabaseImpl(T::class) }
    ): RoomDatabase.Builder<T> = RoomDatabase.Builder(T::class, null, factory)

    public inline fun <reified T : RoomDatabase> databaseBuilder(
        name: String,
        noinline factory: () -> T = { findDatabaseConstructorAndInitDatabaseImpl(T::class) },
    ): RoomDatabase.Builder<T> {
        require(name.isNotBlank()) { "Cannot build a database with empty name." }
        require(name != ":memory:") { "Use Room.inMemoryDatabaseBuilder() for ':memory:'." }
        return RoomDatabase.Builder(T::class, name, factory)
    }
}
