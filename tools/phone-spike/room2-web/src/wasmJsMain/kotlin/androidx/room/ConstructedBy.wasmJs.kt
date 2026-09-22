// Browser (wasmJs) counterpart of a Room 2.8.4 nativeMain file, adapted from the
// released androidx sources jar (Apache License 2.0, The Android Open Source Project).
package androidx.room

import kotlin.reflect.AssociatedObjectKey
import kotlin.reflect.ExperimentalAssociatedObjects
import kotlin.reflect.KClass

@OptIn(ExperimentalAssociatedObjects::class)
@AssociatedObjectKey
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.BINARY)
public actual annotation class ConstructedBy(actual val value: KClass<*>)
