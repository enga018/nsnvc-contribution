plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.enga018.nsnvc.vbgramg"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.enga018.nsnvc.vbgramg"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-prototype"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
