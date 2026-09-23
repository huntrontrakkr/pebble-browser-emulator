package io.rebble.libpebblecommon.di

import io.rebble.libpebblecommon.js.BrowserJsRunner
import io.rebble.libpebblecommon.js.JsRunner
import org.koin.core.module.Module
import org.koin.dsl.bind
import org.koin.dsl.module

/** Upstream's iOS binding, with the browser runner in place of JavaScriptCore's. */
actual val pkjsPlatformModule: Module = module {
    factory { params ->
        BrowserJsRunner(
            appContext = get(),
            libPebble = get(),
            jsTokenUtil = get(),

            device = params.get(),
            scope = params.get(),
            appInfo = params.get(),
            lockerEntry = params.get(),
            jsPath = params.get(),
            urlOpenRequests = params.get(),
            logMessages = params.get(),
            remoteTimelineEmulator = get(),
            httpInterceptorManager = get(),
            notificationConfigFlow = get(),
            pluginRegistry = get(),
            httpClient = get(),
        )
    } bind JsRunner::class
}
