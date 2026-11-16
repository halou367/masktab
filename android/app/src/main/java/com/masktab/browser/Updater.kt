package com.masktab.browser

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File

/**
 * 在线更新的最后一步（决策 N-3）：安装包由核心服务从 GitHub 下载、校验（internal/core/update.go），
 * 这里只负责把它交给系统安装。用系统的 PackageInstaller 会话：不需要把文件共享出去（不用 FileProvider），
 * 系统会弹自己的“要更新这个应用吗”让用户确认；装的是同一个包名、同一个签名，数据不会动。
 * 装好的那一刻系统会把本应用关掉，不会自动再打开（系统不允许应用在后台自己弹出来）。
 */
object Updater {
    private const val ACTION = "com.masktab.browser.UPDATE_STATUS"

    /** 安装下载好的安装包。ok / fail 在主线程回调；ok 只表示已经交给系统，结果由 [UpdateReceiver] 接。 */
    fun install(ok: (Any?) -> Unit, fail: (String) -> Unit) {
        val ctx = Core.app
        bg {
            try {
                val j = CoreProc.json("GET", "/api/update/file", timeoutMs = 120000) // 核心服务在这里再校验一遍（一百多兆，手机上要几秒）
                val f = File(j.str("path"))
                if (!f.isFile || f.length() == 0L) throw RuntimeException("安装包不见了，请重新下载")
                if (!ctx.packageManager.canRequestPackageInstalls()) {
                    // 第一次：系统要用户先允许“MaskTab 安装应用”。打开那一页，回来再点一次。
                    logi("在线更新：还没有“安装未知应用”的许可，打开系统设置")
                    ui {
                        try {
                            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            fail("请先在刚打开的系统页面里允许 MaskTab 安装应用，然后回来再点一次“安装”")
                        } catch (e: Exception) {
                            fail("请先到系统设置里允许 MaskTab“安装未知应用”，然后再点一次“安装”")
                        }
                    }
                    return@bg
                }
                val pi = ctx.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(ctx.packageName)
                params.setSize(f.length())
                val id = pi.createSession(params)
                logi("在线更新：把 ${f.name}（${f.length()} 字节）交给系统安装，会话 $id")
                try {
                    pi.openSession(id).use { s ->
                        s.openWrite("masktab.apk", 0, f.length()).use { out ->
                            f.inputStream().use { it.copyTo(out, 1 shl 16) }
                            s.fsync(out)
                        }
                        val intent = Intent(ctx, UpdateReceiver::class.java).setAction(ACTION)
                        // 系统要往这个意图里填结果，所以必须是可变的；意图写明了接收的类（安卓 14 起可变的不许是隐式的）
                        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                        s.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
                    }
                } catch (e: Exception) {
                    try { pi.abandonSession(id) } catch (x: Exception) { /* 已经提交或者已经没了 */ }
                    throw e
                }
                ui { ok(null) }
            } catch (e: Throwable) {
                logw("在线更新：没能交给系统安装", e)
                val msg = e.message ?: e.toString()
                ui { fail(msg) }
            }
        }
    }

    /** 没装成：告诉核心服务，界面上“组件与更新”那一页会写出来。 */
    fun report(msg: String) {
        logw("在线更新：系统安装没有成功：$msg")
        bg { try { CoreProc.call("POST", "/api/update/result", jsonOf("error" to msg).toString()) } catch (e: Exception) { logw("在线更新：结果没报上去 ${e.message}") } }
        ui { Core.ui?.toast(msg) }
    }
}

/** 系统安装的进展：要用户确认时把系统的确认界面打开；没装成时报上去。装成了收不到（进程已经被换掉）。 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                logi("在线更新：等用户在系统界面上确认")
                if (confirm == null) { Updater.report("系统没有给出安装确认界面"); return }
                try {
                    // 从正开着的界面打开（应用在前台，系统允许）；界面不在了就用应用自己的上下文
                    val act = Core.ui as? Context
                    if (act != null) act.startActivity(confirm) else ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) { Updater.report("系统的安装确认界面打不开：${e.message}") }
            }
            PackageInstaller.STATUS_SUCCESS -> logi("在线更新：装好了")
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.report("安装已取消")
            PackageInstaller.STATUS_FAILURE_STORAGE -> Updater.report("手机存储空间不够，装不上")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                Updater.report("系统拒绝安装：和已装的版本对不上（$detail）。请到发布页下载后手动安装")
            PackageInstaller.STATUS_FAILURE_BLOCKED -> Updater.report("安装被系统或手机管家拦下了（$detail）")
            else -> Updater.report("系统没有装上（$status $detail）")
        }
    }
}
