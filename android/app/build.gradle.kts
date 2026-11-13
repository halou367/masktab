import javax.inject.Inject

plugins {
    id("com.android.application")
}

// GeckoView 固定版本（Mozilla Maven 上 release 通道的 160 正式版）。
val geckoviewVersion = "160.0.20261104181552"

android {
    namespace = "com.masktab.browser"
    // GeckoView 160 要求 compileSdk 37.2（AAR 元数据 minCompileSdk=37、minCompileMinorSdk=2）
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    defaultConfig {
        applicationId = "com.masktab.browser"
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            // 第一版只出调试签名的包
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // 只打 arm64-v8a（真机）与 x86_64（CI 模拟器），每个架构单独出一个 APK：手机装 arm64-v8a 那个。
    // 注意：用了 splits 就不能再写 ndk.abiFilters（AGP 会报冲突）。
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }
    packaging {
        jniLibs {
            // mihomo 以 libmihomo.so 的名字放进 jniLibs，安装时解压到 nativeLibraryDir 才能执行
            useLegacyPackaging = true
            keepDebugSymbols += "**/libmihomo.so"
        }
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview:$geckoviewVersion")
}

// 内置扩展：桌面伴随扩展里能复用的文件（界面工具、站点图标、实例菜单、实例卡片、自动填写、国旗）
// + android/ext 里安卓专用的文件，合成到 assets/ext/。桌面那份是唯一来源，不复制进仓库。
abstract class BuildExt : DefaultTask() {
    @get:InputDirectory abstract val shared: DirectoryProperty
    @get:InputDirectory abstract val own: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction
    fun run() {
        fs.sync {
            into(outputDir.dir("ext"))
            from(own)
            from(shared) {
                include("ui.js", "ui.css", "sites.js", "menu.js", "instances.js", "autofill.js")
                include("assets/flags/**", "assets/icon48.png", "assets/icon128.png")
            }
        }
    }
}

val buildExt = tasks.register<BuildExt>("buildExt") {
    shared.set(rootProject.layout.projectDirectory.dir("../companion/ext"))
    own.set(rootProject.layout.projectDirectory.dir("ext"))
    outputDir.set(layout.buildDirectory.dir("generated/mtext"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(buildExt, BuildExt::outputDir)
    }
}
