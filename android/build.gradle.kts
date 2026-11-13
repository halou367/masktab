// 版本都固定：升级时改这里和 app/build.gradle.kts 里的 GeckoView 版本，再看 CI。
plugins {
    id("com.android.application") version "9.5.1" apply false
    // AGP 9 自带 Kotlin 编译；这里声明更高版本的 Kotlin 插件，是为了能读 GeckoView 160 依赖的 kotlin-stdlib 2.4。
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
