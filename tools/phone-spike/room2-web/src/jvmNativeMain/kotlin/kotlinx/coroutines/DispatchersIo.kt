// kotlinx.coroutines has no IO dispatcher in the browser, where Kotlin/Wasm runs on
// one thread. Code written for Android, desktop and iOS names Dispatchers.IO; here it
// is the default dispatcher.
package kotlinx.coroutines

internal val Dispatchers.IO: CoroutineDispatcher
    get() = Dispatchers.Default
