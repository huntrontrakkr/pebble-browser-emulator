package io.rebble.libpebblecommon.js

/**
 * The browser's form of upstream's iOS `RegisterableJsInterface`: an interface whose
 * methods the runner exposes to the app's JavaScript by name. iOS also hands each one
 * its JavaScriptCore context; the browser runner registers through one dispatcher
 * instead, so upstream's iOS dispatch tables (JSCPKJSInterface, JSCPrivatePKJSInterface,
 * JSCGeolocationInterface) compile here unchanged.
 */
interface RegisterableJsInterface : JsEngineInterface, AutoCloseable {
    val interf: Map<String, *>
    override val methods: List<String> get() = interf.keys.toList()
}
