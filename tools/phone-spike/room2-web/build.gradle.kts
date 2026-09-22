// Browser-only Room 2: the released Room and androidx.sqlite sources, compiled for
// wasmJs with single-thread platform files and an in-memory SQLite Wasm driver
// (src/wasmJsMain). Only libpebble3's browser target depends on it; Android,
// desktop and iOS keep the Room upstream ships. patch.mjs copies this module into
// the upstream checkout and records where room2-sources.sh unpacked the sources.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
}

val released = file(file("sources.path").readText().trim())
fun released(path: String) = released.resolve(path).also {
    check(it.isDirectory) { "Missing released sources: $it (run tools/phone-spike/room2-sources.sh)" }
}

kotlin {
    @OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)
    wasmJs { browser() }

    compilerOptions {
        freeCompilerArgs.add("-Xexpect-actual-classes")
        // The released sources are compiled as they are, warnings included.
        suppressWarnings.set(true)
    }

    sourceSets {
        commonMain {
            kotlin.srcDir(released("room-common/commonMain"))
            kotlin.srcDir(released("sqlite/commonMain"))
            kotlin.srcDir(released("room-runtime/commonMain"))
            kotlin.srcDir(released("room-paging/commonMain"))
            dependencies {
                api(libs.coroutines)
                api("androidx.annotation:annotation:1.9.1")
                api("androidx.collection:collection:1.5.0")
                api("androidx.paging:paging-common:${libs.versions.paging.get()}")
                implementation("org.jetbrains.kotlinx:atomicfu:${libs.versions.atomicfu.get()}")
            }
        }
        wasmJsMain {
            // Blocking statements: the browser driver runs SQLite in-thread.
            kotlin.srcDir(released("sqlite/nonWebMain"))
            // Room's runtime shared by its desktop and native targets.
            kotlin.srcDir(released("room-runtime/jvmNativeMain"))
            kotlin.srcDir(released("room-paging/jvmNativeMain"))
        }
    }
}
