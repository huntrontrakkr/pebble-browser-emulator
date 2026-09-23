// Browser-only kmp-io: the part of kmp-io's released 0.3.0 sources that upstream
// uses (byte buffers, BitSet and byte-array extensions), compiled for wasmJs. These
// files are plain Kotlin; kmp-io's file and compression code is platform-specific
// and not included. Only libpebble3's browser target resolves kmp-io to this module.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
}

val released = file(file("sources.path").readText().trim()).resolve("commonMain")
check(released.isDirectory) { "Missing kmp-io sources: $released (run tools/phone-spike/room2-sources.sh)" }

kotlin {
    @OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)
    wasmJs { browser() }

    compilerOptions {
        // The released sources are compiled as they are, warnings included.
        suppressWarnings.set(true)
    }

    sourceSets {
        commonMain {
            kotlin.srcDir(released)
            kotlin.include(
                "com/oldguy/common/Extensions.kt",
                "com/oldguy/common/io/Buffer.kt",
                "com/oldguy/common/io/ByteBuffers.kt",
                "com/oldguy/common/io/BitSet.kt",
            )
        }
    }
}
