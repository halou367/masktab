package com.masktab.browser

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// 诊断信息：不依赖内置页面（GeckoView）的那一部分——版本与机型、上几次进程是怎么退出的（崩溃 / 无响应 / 被系统杀掉，含子进程）、
// 上次 Java 崩溃的调用栈、本应用自己的日志尾部。真机上白屏、闪退、卡死时靠它定位（模拟器里复现不了）。
object Diag {
    private const val JAVA_CRASH = "crash-java.txt"
    private const val SEEN = "diag-seen.txt"
    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)

    fun version(ctx: Context): String = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?" } catch (e: Exception) { "?" }

    /** 记下未捕获的 Java 异常（下次启动放进诊断信息），然后照常交给系统处理。 */
    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                File(app.filesDir, JAVA_CRASH).writeText("${fmt.format(Date())} 版本 ${version(app)} 线程 ${t.name}\n" + Log.getStackTraceString(e).take(8000))
            } catch (x: Throwable) { /* 记不下来也不能挡住系统的处理 */ }
            prev?.uncaughtException(t, e)
        }
    }

    private fun reasonName(r: Int): String = when (r) {
        ApplicationExitInfo.REASON_ANR -> "无响应（ANR）"
        ApplicationExitInfo.REASON_CRASH -> "Java 崩溃"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "原生崩溃"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "内存不足被杀"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "占用资源过多被杀"
        ApplicationExitInfo.REASON_SIGNALED -> "被信号结束"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "初始化失败"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "依赖的进程死了"
        ApplicationExitInfo.REASON_EXIT_SELF -> "自己退出"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "用户结束"
        ApplicationExitInfo.REASON_USER_STOPPED -> "用户停止"
        ApplicationExitInfo.REASON_OTHER -> "系统结束（其它）"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "权限变化"
        else -> "原因 $r"
    }

    private fun isBad(r: Int) = r == ApplicationExitInfo.REASON_ANR || r == ApplicationExitInfo.REASON_CRASH || r == ApplicationExitInfo.REASON_CRASH_NATIVE ||
        r == ApplicationExitInfo.REASON_LOW_MEMORY || r == ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE || r == ApplicationExitInfo.REASON_INITIALIZATION_FAILURE

    private fun exits(ctx: Context, max: Int): List<ApplicationExitInfo> {
        if (Build.VERSION.SDK_INT < 30) return emptyList()
        return try {
            (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getHistoricalProcessExitReasons(ctx.packageName, 0, max)
        } catch (e: Throwable) { emptyList() }
    }

    /** 上次主进程是不是异常退出的（崩溃 / 无响应 / 内存不足）：是就返回一句说明，只提示一次。 */
    fun lastBadExit(ctx: Context): String? {
        val mark = File(ctx.filesDir, SEEN)
        val seen = try { mark.readText().trim().toLong() } catch (e: Exception) { 0L }
        var newest = seen
        var why: String? = null
        for (x in exits(ctx, 12)) {
            if (x.timestamp <= seen) continue
            if (x.timestamp > newest) newest = x.timestamp
            // 只看主进程和 GPU 进程：网页进程被系统回收是常事，不用打扰
            val main = x.processName == ctx.packageName || x.processName.contains(":gpu")
            if (why == null && main && isBad(x.reason)) why = "${fmt.format(Date(x.timestamp))} ${x.processName.substringAfter(ctx.packageName).ifEmpty { "主进程" }}：${reasonName(x.reason)}"
        }
        val jc = File(ctx.filesDir, JAVA_CRASH)
        if (why == null && jc.exists() && jc.lastModified() > seen) { why = "上次有一个 Java 崩溃"; if (jc.lastModified() > newest) newest = jc.lastModified() }
        if (newest > seen) try { mark.writeText(newest.toString()) } catch (e: Exception) { /* 忽略 */ }
        return why
    }

    /** 可打印字符串（原生崩溃的墓碑文件是二进制格式，这里只把里面的可读片段挑出来：信号、终止消息、出事的库名和函数名）。 */
    private fun strings(b: ByteArray, min: Int, max: Int): List<String> {
        val out = LinkedHashSet<String>()
        val sb = StringBuilder()
        for (x in b) {
            val c = x.toInt() and 0xff
            if (c in 0x20..0x7e) sb.append(c.toChar()) else { if (sb.length >= min) out.add(sb.toString().take(160)); sb.setLength(0); if (out.size >= max) break }
        }
        if (sb.length >= min && out.size < max) out.add(sb.toString().take(160))
        return out.toList()
    }

    private fun exitText(ctx: Context): String {
        val l = exits(ctx, 10)
        if (l.isEmpty()) return if (Build.VERSION.SDK_INT < 30) "（安卓 11 以下没有这项记录）\n" else "（没有记录）\n"
        val sb = StringBuilder()
        var traces = 0
        for (x in l) {
            sb.append("${fmt.format(Date(x.timestamp))} ${x.processName.substringAfter(ctx.packageName).ifEmpty { "主进程" }} ${reasonName(x.reason)} 状态 ${x.status} 重要性 ${x.importance} 内存 ${x.pss / 1024}MB")
            x.description?.let { sb.append(" · ").append(it.take(200)) }
            sb.append('\n')
            if (traces < 2 && (x.reason == ApplicationExitInfo.REASON_ANR || x.reason == ApplicationExitInfo.REASON_CRASH_NATIVE)) {
                try {
                    val bytes = x.traceInputStream?.use { it.readBytes() }
                    if (bytes != null && bytes.isNotEmpty()) {
                        traces++
                        if (x.reason == ApplicationExitInfo.REASON_ANR) {
                            // ANR 的记录是文本：取主线程那一段
                            val t = String(bytes, Charsets.UTF_8)
                            val i = t.indexOf("\"main\"")
                            sb.append((if (i >= 0) t.substring(i) else t).lineSequence().take(45).joinToString("\n") { "    $it".take(200) }).append('\n')
                        } else {
                            sb.append(strings(bytes, 6, 400).filter { s -> s.contains(".so") || s.contains("SIG") || s.contains("Abort") || s.contains("abort") || s.contains("egl", true) || s.contains("gl", true) || s.contains("moz", true) || s.contains("Gecko") || s.contains("assert", true) }
                                .take(40).joinToString("\n") { "    $it" }).append('\n')
                        }
                    }
                } catch (e: Throwable) { sb.append("    （读不到详细记录：${e.message}）\n") }
            }
        }
        return sb.toString()
    }

    /** 本应用自己的日志尾部（系统只让应用读自己的日志）：警告以上，加上本应用的标签。 */
    private fun logTail(maxLines: Int): String = try {
        val p = ProcessBuilder("logcat", "-d", "-t", "1500", "-v", "time", "MaskTab:I", "GeckoConsole:W", "AndroidRuntime:E", "Gecko:W", "GeckoViewActivity:W", "libc:F", "DEBUG:F", "*:E").redirectErrorStream(true).start()
        val lines = p.inputStream.bufferedReader().readLines()
        p.destroy()
        lines.filter { it.isNotBlank() && !it.startsWith("-----") && !it.contains("No impl for message") && !it.contains("receiveMessage@") && !it.contains("onMessageFromActor@") }
            .takeLast(maxLines).joinToString("\n") { it.take(300) }
    } catch (e: Throwable) { "（读不到日志：${e.message}）" }

    fun collect(ctx: Context): String {
        val sb = StringBuilder()
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        sb.append("MaskTab ${version(ctx)} · Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}） · ${Build.MANUFACTURER} ${Build.MODEL} · ${Build.SUPPORTED_ABIS.joinToString("/")}\n")
        sb.append("系统 ${Build.DISPLAY.take(60)} · 芯片 ${Build.HARDWARE}${if (Build.VERSION.SDK_INT >= 31) " " + Build.SOC_MODEL else ""} · 内存 ${mi.totalMem / 1048576}MB（可用 ${mi.availMem / 1048576}MB${if (mi.lowMemory) "，紧张" else ""}） · ${fmt.format(Date())}\n")
        // 应用内部状态（内核、扩展、mihomo、各实例、页面报错）；内核还没起来时这段可能取不到
        try { if (Core.started || Core.runtime != null) sb.append(Core.diag()) else sb.append("内核还没启动\n") } catch (e: Throwable) { sb.append("应用状态取不到：$e\n") }
        sb.append("—— 最近几次进程退出 ——\n").append(exitText(ctx))
        val jc = File(ctx.filesDir, JAVA_CRASH)
        if (jc.exists()) sb.append("—— 上次 Java 崩溃 ——\n").append(try { jc.readText().take(5000) } catch (e: Exception) { "读不到" }).append('\n')
        sb.append("—— 日志尾部 ——\n").append(logTail(120)).append('\n')
        var t = sb.toString()
        val sub = try { Core.store.subUrl } catch (e: Throwable) { "" }
        if (sub.isNotEmpty()) t = t.replace(sub, "<订阅地址>")
        return t.take(24000)
    }
}
