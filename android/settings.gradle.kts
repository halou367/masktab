// MaskTab 安卓版（GeckoView 内核），见 docs/android.md。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // GeckoView 只发布在 Mozilla 自己的 Maven 仓库
        maven("https://maven.mozilla.org/maven2/")
    }
}
rootProject.name = "MaskTab"
include(":app")
