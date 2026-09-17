plugins {
    kotlin("multiplatform") version "2.4.10"
    id("org.jetbrains.compose") version "1.11.1"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10"
}
kotlin {
    wasmJs {
        browser { commonWebpackConfig { outputFileName = "pebble-phone.js" } }
        binaries.executable()
    }
    sourceSets {
        wasmJsMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(compose.materialIconsExtended)
            implementation(compose.ui)
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("io.ktor:ktor-http:3.5.1")
        }
    }
}
dependencyLocking { lockAllConfigurations() }
