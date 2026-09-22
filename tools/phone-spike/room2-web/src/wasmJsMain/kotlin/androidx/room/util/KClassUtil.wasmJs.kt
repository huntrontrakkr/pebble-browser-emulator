// Browser (wasmJs) counterpart of a Room 2.8.4 nativeMain file, adapted from the
// released androidx sources jar (Apache License 2.0, The Android Open Source Project).
@file:RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)

package androidx.room.util

import androidx.annotation.RestrictTo
import androidx.room.ConstructedBy
import androidx.room.RoomDatabase
import androidx.room.RoomDatabaseConstructor
import kotlin.reflect.ExperimentalAssociatedObjects
import kotlin.reflect.KClass
import kotlin.reflect.findAssociatedObject

@OptIn(ExperimentalAssociatedObjects::class)
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP_PREFIX) // used in generated code
public fun <T : RoomDatabase> findDatabaseConstructorAndInitDatabaseImpl(klass: KClass<*>): T {
    val constructor = klass.findAssociatedObject<ConstructedBy>() as? RoomDatabaseConstructor<*>
    checkNotNull(constructor) {
        "Cannot find the associated ${RoomDatabaseConstructor::class.qualifiedName} for " +
            "${klass.qualifiedName}. Is Room annotation processor correctly configured?"
    }
    @Suppress("UNCHECKED_CAST") // Actually safe due to annotation processor enforcement
    return constructor.initialize() as T
}
