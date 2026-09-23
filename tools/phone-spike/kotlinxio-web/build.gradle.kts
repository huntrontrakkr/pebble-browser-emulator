// Browser-only kotlinx-io: the released sources of the kotlinx-io-core version upstream
// pins (Apache-2.0), compiled for wasmJs with its Node file backend replaced. The
// released wasmJs build reaches files, paths and the OS through `node:fs`, `node:path`
// and `node:os`, which exist only under Node, so in a page any kotlinx.io.files call
// fails. Here files live in memory for the session (src/wasmJsMain). Everything else is
// compiled as released. Only libpebble3's browser target resolves kotlinx-io-core to
// this module; patch.mjs copies it and records where room2-sources.sh unpacked the jar.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
}

val released = file(file("sources.path").readText().trim())
fun released(path: String) = released.resolve(path).also {
    check(it.isDirectory) { "Missing kotlinx-io sources: $it (run tools/phone-spike/room2-sources.sh)" }
}

kotlin {
    @OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)
    wasmJs {
        browser()
        // Other libraries were compiled against the published module; keep its name.
        compilerOptions { moduleName.set("org.jetbrains.kotlinx:kotlinx-io-core") }
    }

    compilerOptions {
        freeCompilerArgs.add("-Xexpect-actual-classes")
        optIn.addAll(
            "kotlinx.io.InternalIoApi",
            "kotlinx.io.unsafe.UnsafeIoApi",
            "kotlin.js.ExperimentalWasmJsInterop",
        )
        // The released sources are compiled as they are, warnings included.
        suppressWarnings.set(true)
    }

    sourceSets {
        commonMain {
            kotlin.srcDir(released("commonMain"))
            dependencies {
                api("org.jetbrains.kotlinx:kotlinx-io-bytestring:${libs.versions.kotlinx.io.get()}")
            }
        }
        wasmJsMain {
            kotlin.srcDir(released("wasmMain"))
            // Only `try.kt` (withCaughtException) from the Node-shared set; its files and
            // node directories are the backend this module replaces.
            kotlin.srcDir(released("nodeFilesystemSharedMain"))
            kotlin.srcDir("src/wasmJsMain/kotlin")
            kotlin.exclude("files/**", "node/**")
        }
    }
}
