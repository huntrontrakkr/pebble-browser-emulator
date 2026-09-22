// Browser (wasmJs) counterparts of Room 2.8.4's nativeMain concurrency files. The
// browser runs Kotlin/Wasm on one thread, so atomics are plain fields, there is
// one thread-local slot, and the lock and synchronized use atomicfu as native
// and a lock needs no exclusion. Room's multiplatform runtime (Apache License 2.0) defines the contracts.
@file:androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)

package androidx.room.concurrent

import kotlin.coroutines.CoroutineContext

public actual class AtomicInt actual constructor(initialValue: Int) {
    private var value = initialValue
    public actual fun get(): Int = value
    public actual fun set(value: Int) {
        this.value = value
    }
    public actual fun compareAndSet(expect: Int, update: Int): Boolean =
        (value == expect).also { if (it) value = update }
    public actual fun incrementAndGet(): Int = ++value
    public actual fun getAndIncrement(): Int = value++
    public actual fun decrementAndGet(): Int = --value
}

public actual class AtomicBoolean actual constructor(initialValue: Boolean) {
    private var value = initialValue
    public actual fun get(): Boolean = value
    public actual fun compareAndSet(expect: Boolean, update: Boolean): Boolean =
        (value == expect).also { if (it) value = update }
}

// Native aliases atomicfu's SynchronizedObject, which on the browser is only an
// alias of Any; with one thread there is nothing to exclude, so these are classes
// whose locking does nothing.
internal actual class ReentrantLock actual constructor() {
    actual fun lock() {}
    actual fun unlock() {}
    actual fun tryLock(): Boolean = true
}

internal actual open class SynchronizedObject actual constructor()

internal actual inline fun <T> synchronized(lock: SynchronizedObject, block: () -> T): T = block()

@androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY)
public actual class ThreadLocal<T> {
    private var value: T? = null
    public actual fun get(): T? = value
    public actual fun set(value: T?) {
        this.value = value
    }
}

internal actual fun <T> ThreadLocal<T>.asContextElement(value: T): CoroutineContext.Element =
    ThreadContextElement()

// As on native: a placeholder element, see Kotlin/kotlinx.coroutines#3326.
private class ThreadContextElement : CoroutineContext.Element {
    companion object Key : CoroutineContext.Key<ThreadContextElement>
    override val key: CoroutineContext.Key<ThreadContextElement>
        get() = ThreadContextElement
}

internal actual fun currentThreadId(): Long = 1L

/** The browser phone's database is in memory, so there is no file to lock. */
internal actual class FileLock actual constructor(filename: String) {
    actual fun lock() {}
    actual fun unlock() {}
}
