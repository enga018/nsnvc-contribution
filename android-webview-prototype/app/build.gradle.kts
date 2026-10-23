plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "in.enga018.nsnvc.vbgramg"
    compileSdk = 35
    defaultConfig {
        applicationId = "in.enga018.nsnvc.vbgramg"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-prototype"
    }
    kotlinOptions { jvmTarget = "17" }
}
java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(17)) }
}
