# Build and runtime provenance

Exact transitive versions are recorded in `gradle.lockfile` and
`kotlin-js-store/wasm/package-lock.json`. `gradle/wrapper/gradle-wrapper.properties`
pins and verifies Gradle 9.6.1. Maven Central and Google's Maven repository supply the
unmodified Kotlin artifacts; npm supplies the locked build dependencies.

Runtime source projects:

| Component | Version | Source | License |
| --- | --- | --- | --- |
| Kotlin standard library | 2.4.10 | https://github.com/JetBrains/kotlin/tree/v2.4.10 | Apache-2.0 |
| Compose Multiplatform | 1.11.1 | https://github.com/JetBrains/compose-multiplatform/tree/v1.11.1 | Apache-2.0 |
| Compose UI/runtime/foundation/material | see Gradle lock | https://github.com/JetBrains/compose-multiplatform-core | Apache-2.0 |
| kotlinx.coroutines | 1.11.0 | https://github.com/Kotlin/kotlinx.coroutines/tree/1.11.0 | Apache-2.0 |
| kotlinx.serialization | see Gradle lock | https://github.com/Kotlin/kotlinx.serialization | Apache-2.0 |
| kotlinx-datetime | see Gradle lock | https://github.com/Kotlin/kotlinx-datetime | Apache-2.0 |
| Ktor HTTP | 3.5.1 | https://github.com/ktorio/ktor/tree/3.5.1 | Apache-2.0 |
| Skiko graphics runtime | 0.144.6 | https://github.com/JetBrains/skiko/tree/9a5b398bb2044fff7e7a84fbfd6f4b803e4427c0 | Apache-2.0 and bundled notices |
| js-joda | see npm lock | https://github.com/js-joda/js-joda | BSD-3-Clause |

`licenses/` includes upstream license texts and the Skiko redistribution notice, with
download sources and hashes. Kotlin compiler, Gradle, webpack and Binaryen run during the
local build; they are not an application server or a browser compilation service.

Skiko pins [Skia m144-22f58c9fd4](https://github.com/JetBrains/skia/tree/m144-22f58c9fd4).
The [matching source dependencies](https://github.com/JetBrains/skia/blob/m144-22f58c9fd4/DEPS)
pin its graphics, image, font and Unicode libraries. Their applicable notices, including
FreeType's FTL, HarfBuzz, ICU, JPEG, PNG, WebP, Brotli, Expat, Wuffs and zlib, are retained
under `licenses/`; `sources.json` records exact downloads and SHA-256 checksums.
FreeType portions are copyright The FreeType Project (https://freetype.org/), all rights reserved.
