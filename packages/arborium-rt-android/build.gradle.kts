// Android library (AAR) wrapping the arborium-rt JNI shim (`ffi/android`).
//
// The prebuilt `libarborium_rt.so` for each ABI is cross-compiled by
// `./scripts/arborium-rt build android` (cargo-ndk) into
// `src/main/jniLibs/<abi>/` — the default jniLibs source dir, so AGP packages
// them into the AAR with no extra config. The Kotlin binding + high-level
// wrapper live in `src/main/kotlin/`.
//
// Publishing: `./gradlew publish` pushes `com.discord:arborium-rt-android:<VERSION_NAME>`
// to the configured Maven repo so a private `build.gradle` at Discord can pull
// it as a normal dependency. The repo defaults to GitHub Packages Maven for
// this repository; point `ARBORIUM_MAVEN_URL` at an internal Artifactory/Maven
// to publish there instead (a one-line override — the coordinates don't change).

plugins {
    id("com.android.library") version "8.5.2"
    kotlin("android") version "2.0.20"
    kotlin("plugin.serialization") version "2.0.20"
    id("maven-publish")
}

group = providers.gradleProperty("GROUP").get()
version = providers.gradleProperty("VERSION_NAME").get()

android {
    namespace = "com.discord.arborium"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Emit a single `release` component for maven-publish to consume.
    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = providers.gradleProperty("GROUP").get()
            artifactId = providers.gradleProperty("ARTIFACT_ID").get()
            version = providers.gradleProperty("VERSION_NAME").get()
            afterEvaluate { from(components["release"]) }
        }
    }
    repositories {
        maven {
            name = "arborium"
            // Defaults to GitHub Packages Maven for this repo; override with
            // ARBORIUM_MAVEN_URL to publish to an internal Artifactory/Maven.
            url = uri(
                System.getenv("ARBORIUM_MAVEN_URL")
                    ?: "https://maven.pkg.github.com/discord/arborium-rt",
            )
            credentials {
                username = System.getenv("ARBORIUM_MAVEN_USER")
                    ?: System.getenv("GITHUB_ACTOR")
                password = System.getenv("ARBORIUM_MAVEN_TOKEN")
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
