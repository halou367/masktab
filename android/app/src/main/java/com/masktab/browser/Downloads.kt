package com.masktab.browser

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.WebResponse
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URL
import java.net.URLDecoder

// 下载文件（决策 A-14）。
//
// 两条路，都只走这个实例自己的线路，绝不直连：
//   1. 网页里点出来的下载（内核的 onExternalResponse）：内容是内核已经在这个实例的线路上、带着它的 Cookie 取回来的，这里只管把它存下来。
//   2. 长按菜单里的“下载链接 / 保存图片”、三点菜单的“下载此页”：内核没有“把这个地址下载下来”的接口。让内核在这个实例里再开一次这个网址，
//      内置扩展把这一次的响应标成附件（Content-Disposition: attachment），内核就把它当下载交回来，接着走第 1 条路（Core.download）。
//      请求仍是内核发的：线路、Cookie、UA、TLS 特征都和网页一样。app 自己从不出网取文件。
//
// 存到哪：安卓 10 及以上放进系统的“下载”文件夹（MediaStore，不用申请存储权限，文件管理器、相册都看得到）；
// 安卓 8、9 放在 app 自己的外部目录 Android/data/com.masktab.browser/files/Download（同样不用权限），打开 / 分享时经 FileProvider 交出去。
//
// 记录按实例分开（files/downloads.json，最多 200 条）；文件本身不分实例。

object Downloads {
    const val RUN = "run"
    const val DONE = "done"
    const val FAIL = "fail"
    private const val MAX = 200

    class Item(val id: String, val inst: String, @Volatile var name: String, val url: String, val from: String, @Volatile var mime: String, @Volatile var total: Long, val at: Long) {
        @Volatile var got = 0L
        @Volatile var state = RUN
        @Volatile var err = ""
        /** 存好的文件：content://…（系统下载文件夹）或文件路径（安卓 9 及以下）。 */
        @Volatile var uri = ""
        /** 响应头里的长度能不能当真（压缩传输的不能：收到的是解压后的字节数）。 */
        var exact = true
        @Volatile var stop = false
        @Volatile var src: Closeable? = null
        fun json(): JSONObject = jsonOf(
            "id" to id, "inst" to inst, "name" to name, "url" to (if (url.startsWith("data:")) "" else url), "from" to from, "mime" to mime,
            "total" to total, "got" to got, "state" to state, "err" to err, "at" to at, "uri" to uri,
        )
    }

    private val list = ArrayList<Item>() // 新的在前
    private var loaded = false
    private val file get() = File(Core.app.filesDir, "downloads.json")

    private fun load() {
        synchronized(list) {
            if (loaded) return
            loaded = true
            try {
                for (j in JSONArray(file.readText()).objects()) {
                    val it = Item(j.str("id"), j.str("inst"), j.str("name"), j.str("url"), j.str("from"), j.str("mime"), j.optLong("total", -1), j.optLong("at"))
                    it.got = j.optLong("got"); it.state = j.str("state", FAIL); it.err = j.str("err"); it.uri = j.str("uri")
                    // 上次下到一半 app 就没了：内核那头的连接已经断了，接不上
                    if (it.state == RUN) { it.state = FAIL; it.err = "上次没下完（应用被关掉了）"; it.uri = "" }
                    list.add(it)
                }
            } catch (e: Exception) { }
        }
    }

    private fun save() {
        val a = JSONArray()
        synchronized(list) { for (it in list) a.put(it.json()) }
        bg { synchronized(file) { writeAtomic(file, a.toString().toByteArray()) } }
    }

    fun list(inst: String): JSONArray {
        load()
        val a = JSONArray()
        synchronized(list) { for (it in list) if (it.inst == inst) a.put(it.json().also { j -> j.remove("uri") }) }
        return a
    }

    fun get(id: String): Item? { load(); return synchronized(list) { list.firstOrNull { it.id == id } } }

    fun running(): Int = synchronized(list) { list.count { it.state == RUN } }

    private fun runningItems(): List<Item> = synchronized(list) { list.filter { it.state == RUN } }

    // ---------- 文件名 ----------

    private fun clean(s: String): String {
        var n = s.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().trim('.').trim()
        if (n.length > 120) {
            val ext = n.substringAfterLast('.', "").takeIf { it.length in 1..10 }
            n = if (ext != null) n.dropLast(ext.length + 1).take(120 - ext.length - 1) + "." + ext else n.take(120)
        }
        return n
    }

    /** 文件名：先看响应头 Content-Disposition（filename*= 优先），再看网址最后一段；没有扩展名的按类型补一个。 */
    fun fileName(disposition: String, url: String, mime: String): String {
        var n = ""
        Regex("filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)", RegexOption.IGNORE_CASE).find(disposition)?.let { m ->
            n = try { URLDecoder.decode(m.groupValues[2].trim().trim('"').replace("+", "%2B"), m.groupValues[1].trim().ifEmpty { "UTF-8" }) } catch (e: Exception) { "" }
        }
        if (n.isEmpty()) Regex("filename\\s*=\\s*(\"([^\"]*)\"|[^;]+)", RegexOption.IGNORE_CASE).find(disposition)?.let { m ->
            n = m.groupValues[2].ifEmpty { m.groupValues[1] }.trim().trim('"')
            if (Regex("%[0-9a-fA-F]{2}").containsMatchIn(n)) n = try { URLDecoder.decode(n.replace("+", "%2B"), "UTF-8") } catch (e: Exception) { n }
            // 有的服务器直接把 UTF-8 字节塞在头里，按单字节读出来就是乱码：能按 UTF-8 完整读回来的就读回来
            else if (n.any { it.code in 0x80..0xff } && n.none { it.code > 0xff }) {
                val t = String(n.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
                if (!t.contains('\uFFFD')) n = t
            }
        }
        if (n.isEmpty() && (url.startsWith("http://") || url.startsWith("https://"))) {
            val seg = (try { URL(url).path } catch (e: Exception) { "" } ?: "").trimEnd('/').substringAfterLast('/')
            if (seg.isNotEmpty()) n = try { URLDecoder.decode(seg.replace("+", "%2B"), "UTF-8") } catch (e: Exception) { seg }
        }
        n = clean(n)
        val m = mime.substringBefore(';').trim().lowercase()
        if (n.isEmpty()) n = if (m.startsWith("image/")) "图片" else if (m.startsWith("video/")) "视频" else if (m.startsWith("audio/")) "音频" else "下载"
        val ext = n.substringAfterLast('.', "")
        if (ext.isEmpty() || ext.length > 10 || ext.contains(' ')) {
            val e = MimeTypeMap.getSingleton().getExtensionFromMimeType(m)
            if (!e.isNullOrEmpty() && m != "application/octet-stream") n += ".$e"
        }
        return n
    }

    /** 交给系统登记、打开时用的类型：只认扩展名（系统发现类型和扩展名对不上会自己在文件名后面再加一个扩展名）。 */
    private fun mimeOf(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    // ---------- 存放 ----------

    private class Sink(val out: OutputStream, val uri: String, val name: String, val done: (Boolean) -> String?)

    private fun sink(name: String): Sink {
        val ctx = Core.app
        if (Build.VERSION.SDK_INT >= 29) {
            val cr = ctx.contentResolver
            val cv = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val u = cr.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv) ?: throw IOException("系统没给存放的位置")
            val out = try { cr.openOutputStream(u) ?: throw IOException("打不开存放的位置") } catch (e: Exception) { try { cr.delete(u, null, null) } catch (x: Exception) { }; throw e }
            return Sink(out, u.toString(), name) { ok ->
                if (!ok) { try { cr.delete(u, null, null) } catch (e: Exception) { }; null } else {
                    cr.update(u, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                    // 重名时系统会改成“名字 (1).扩展名”，以它登记的为准
                    try { cr.query(u, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } } catch (e: Exception) { null }
                }
            }
        }
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(ctx.filesDir, "Download")
        dir.mkdirs()
        val base = name.substringBeforeLast('.', name)
        val ext = if (name.contains('.')) "." + name.substringAfterLast('.') else ""
        var f = File(dir, name)
        var k = 1
        while (f.exists()) { f = File(dir, "$base ($k)$ext"); k++ }
        return Sink(f.outputStream(), f.path, f.name) { ok -> if (!ok) f.delete(); null }
    }

    // ---------- 下载 ----------

    private class Stopped : IOException("已取消")

    private fun why(e: Throwable): String = when (e) {
        is Stopped -> "已取消"
        is java.net.SocketTimeoutException -> "等了太久没有数据"
        is java.net.ConnectException -> "连不上（这个实例的线路不通）"
        is java.net.UnknownHostException -> "找不到这个网站"
        is SecurityException -> "系统不让写入下载文件夹"
        else -> (e.message ?: e.javaClass.simpleName).take(120)
    }

    private fun start(it: Item, onEnd: () -> Unit, body: (Item) -> InputStream) {
        load()
        synchronized(list) { list.add(0, it); while (list.size > MAX) list.removeAt(list.size - 1) }
        save()
        logi("下载开始 实例 ${it.inst} ${it.name} 类型 ${it.mime.ifEmpty { "—" }} 长度 ${it.total}")
        ui { Keep.sync(); Core.ui?.onDownload(it) }
        bg {
            var sk: Sink? = null
            var ok = false
            try {
                val ins = body(it)
                if (it.src == null) it.src = ins
                if (it.stop) throw Stopped()
                sk = sink(it.name)
                it.uri = sk.uri; it.name = sk.name
                val buf = ByteArray(64 * 1024)
                ins.use { i -> sk.out.use { o ->
                    while (true) {
                        if (it.stop) throw Stopped()
                        val n = i.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        it.got += n
                        tick()
                    }
                } }
                if (it.exact && it.total > 0 && it.got < it.total) throw IOException("只收到一部分（${size(it.got)} / ${size(it.total)}），连接断了")
                ok = true
            } catch (e: Throwable) {
                it.err = if (it.stop) "已取消" else why(e)
                if (!it.stop) logw("下载出错 ${it.name}：${e.javaClass.simpleName} ${e.message}")
            }
            try { it.src?.close() } catch (e: Exception) { }
            it.src = null
            try { sk?.done?.invoke(ok)?.let { n -> it.name = n } } catch (e: Exception) { if (ok) { ok = false; it.err = why(e) } }
            if (!ok) it.uri = ""
            if (ok && it.total < 0) it.total = it.got
            it.state = if (ok) DONE else FAIL
            if (it.stop) synchronized(list) { list.remove(it) }
            save()
            logi(if (ok) "下载完成 ${it.name} ${it.got} 字节 → ${if (it.uri.startsWith("content:")) "系统下载文件夹" else it.uri}" else "下载没成 ${it.name}：${it.err}")
            ui {
                Keep.sync()
                if (!it.stop) { Keep.finished(it); Core.ui?.onDownload(it) }
                try { onEnd() } catch (e: Exception) { logw("下载收尾出错", e) }
            }
        }
    }

    @Volatile private var lastTick = 0L
    private fun tick() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastTick > 900) { lastTick = now; ui { Keep.sync() } }
    }

    /** 网页里点出来的下载：内核已经把响应取回来了，这里只管存。onEnd 在主线程，下完 / 失败 / 取消都会叫。 */
    fun fromResponse(inst: String, r: WebResponse, from: String, onEnd: () -> Unit = {}) {
        val h = { k: String -> r.headers.entries.firstOrNull { it.key.equals(k, true) }?.value ?: "" }
        val body = r.body
        if (body == null) { Core.ui?.toast("这个下载没有内容"); onEnd(); return }
        val mime = h("content-type").substringBefore(';').trim()
        val it = Item(randomHex(6), inst, fileName(h("content-disposition"), r.uri, mime), r.uri, from, mime, h("content-length").trim().toLongOrNull() ?: -1L, System.currentTimeMillis())
        it.exact = h("content-encoding").isEmpty()
        r.setReadTimeoutMillis(60000)
        start(it, onEnd) { body }
    }

    /**
     * 长按“下载链接 / 保存图片”、三点菜单“下载此页”。内核没有“把这个网址下下来”的接口，app 也不自己去取
     * （自己取就拿不到这个实例的 Cookie：内核的扩展接口按 GeckoView 的会话分组查不了 Cookie，模拟器里实测存要登录的图片回 403）。
     * 做法见 Core.download：让内核在这个实例里再开一次这个网址，内置扩展把这一次的响应标成附件，内核就把它当下载交回来。
     * kind 只用在提示里（图片 / 视频 / 文件）。
     */
    fun fromUrl(i: Inst, url: String, from: String, kind: String = "文件") {
        if (url.startsWith("data:")) { fromData(i.id, url, from, kind); return }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Core.ui?.toast(if (url.startsWith("blob:")) "这个${kind}是网页临时生成的，存不了；用网页自己的下载按钮试试" else "这个地址下载不了")
            return
        }
        if (!i.running) { Core.ui?.toast("实例 #${i.no} 还没启动，下载不了"); return }
        Core.download(i, url, from, referer(from, url))
    }

    /** 还没开始存就失败了（服务器回了 403、连不上……）：记一条“没下成”，界面上照常提示。 */
    fun failed(inst: String, url: String, from: String, err: String) {
        load()
        val it = Item(randomHex(6), inst, fileName("", url, ""), url, from, "", -1L, System.currentTimeMillis())
        it.state = FAIL; it.err = err
        synchronized(list) { list.add(0, it); while (list.size > MAX) list.removeAt(list.size - 1) }
        save()
        logi("下载没成 ${it.name}：$err")
        ui { Keep.finished(it); Core.ui?.onDownload(it) }
    }

    /** 浏览器默认的来源页规则（strict-origin-when-cross-origin）：同站给完整地址，跨站只给站点，https → http 不给。 */
    private fun referer(from: String, to: String): String? {
        if (!from.startsWith("http")) return null
        return try {
            val f = URL(from); val t = URL(to)
            if (f.protocol == "https" && t.protocol == "http") null
            else if (f.protocol == t.protocol && f.host == t.host && f.port == t.port) from.substringBefore('#')
            else f.protocol + "://" + f.authority + "/"
        } catch (e: Exception) { null }
    }

    private fun fromData(inst: String, url: String, from: String, kind: String) {
        val head = url.substring(5).substringBefore(',')
        val mime = head.substringBefore(';').trim().ifEmpty { "text/plain" }
        val it = Item(randomHex(6), inst, fileName("", "", mime), "data:", from, mime, -1L, System.currentTimeMillis())
        start(it, {}) { x ->
            val data = url.substringAfter(',', "")
            val bytes = try {
                if (head.endsWith(";base64", true)) Base64.decode(data, Base64.DEFAULT) else URLDecoder.decode(data.replace("+", "%2B"), "UTF-8").toByteArray(Charsets.ISO_8859_1)
            } catch (e: Exception) { throw IOException("这个${kind}的内容读不出来") }
            x.total = bytes.size.toLong()
            ByteArrayInputStream(bytes)
        }
    }

    // ---------- 列表里的操作 ----------

    private fun shareUri(it: Item): Uri? {
        if (it.state != DONE || it.uri.isEmpty()) return null
        if (it.uri.startsWith("content:")) {
            val u = Uri.parse(it.uri)
            val there = try { Core.app.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> c.count > 0 } ?: false } catch (e: Exception) { false }
            return if (there) u else null
        }
        val f = File(it.uri)
        if (!f.exists()) return null
        return try { FileProvider.getUriForFile(Core.app, Core.app.packageName + ".files", f) } catch (e: Exception) { logw("文件交不出去", e); null }
    }

    /** 用别的应用打开。返回 null = 好了，否则是给用户看的原因。 */
    fun open(ctx: Context, it: Item): String? {
        val u = shareUri(it) ?: return "文件已经不在了（可能被删掉或挪走了）"
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(u, mimeOf(it.name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try { ctx.startActivity(i); logi("打开下载的文件 ${it.name}"); null }
        catch (e: ActivityNotFoundException) { logi("没有能打开这种文件的应用 ${it.name}"); "手机上没有能打开这种文件的应用" }
        catch (e: Exception) { logw("下载的文件打不开 ${it.name}", e); why(e) }
    }

    fun share(ctx: Context, it: Item): String? {
        val u = shareUri(it) ?: return "文件已经不在了（可能被删掉或挪走了）"
        val i = Intent(Intent.ACTION_SEND).setType(mimeOf(it.name)).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        i.clipData = ClipData.newRawUri(it.name, u)
        return try { ctx.startActivity(Intent.createChooser(i, "分享文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)); null } catch (e: Exception) { "没有可用的应用" }
    }

    /** 取消正在下的（已经存下的那一截一起删掉，记录也去掉）。 */
    fun cancel(it: Item) {
        it.stop = true
        val s = it.src
        bg { try { s?.close() } catch (e: Exception) { } }
    }

    /** 从列表里去掉；withFile = 连文件一起删。 */
    fun remove(it: Item, withFile: Boolean) {
        if (it.state == RUN) { cancel(it); return }
        synchronized(list) { list.remove(it) }
        save()
        if (withFile && it.uri.isNotEmpty()) bg {
            try {
                if (it.uri.startsWith("content:")) Core.app.contentResolver.delete(Uri.parse(it.uri), null, null) else File(it.uri).delete()
            } catch (e: Exception) { logw("文件没删掉 ${it.name}：${e.message}") }
        }
    }

    /** 清空一个实例的下载记录（文件留着；正在下的不动）。 */
    fun clear(inst: String) {
        load()
        synchronized(list) { list.removeAll { it.inst == inst && it.state != RUN } }
        save()
    }

    /** 删掉实例时：它的记录一起去掉，正在下的停掉。 */
    fun dropInst(inst: String) {
        load()
        for (it in runningItems()) if (it.inst == inst) cancel(it)
        clear(inst)
    }

    fun size(n: Long): String = when {
        n < 0 -> "?"
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${n / 1024} KB"
        n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1048576.0)
        else -> "%.2f GB".format(n / 1073741824.0)
    }

    // ---------- 通知 + 保活 ----------
    // 有文件在下时开一个前台服务：切到别的应用、锁屏，系统也不会把 app 收走，文件能下完；通知栏里显示进度。
    // 用户没给通知权限时（安卓 13 起要问）服务照样算前台，只是看不到通知。

    object Keep {
        const val NID = 7101
        private const val CH = "downloads"
        private var on = false
        private var gaveUp = false
        var svc: DownloadService? = null

        private fun nm(ctx: Context) = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        private fun channel(ctx: Context) {
            if (nm(ctx).getNotificationChannel(CH) == null) {
                nm(ctx).createNotificationChannel(NotificationChannel(CH, "下载", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
            }
        }

        private fun tap(ctx: Context): PendingIntent = PendingIntent.getActivity(
            ctx, 1, Intent(ctx, MainActivity::class.java).putExtra("mt_open", "downloads").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun progress(ctx: Context): Notification {
            channel(ctx)
            val l = runningItems()
            val b = Notification.Builder(ctx, CH).setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(tap(ctx))
            if (l.isEmpty()) return b.setContentTitle("下载").build()
            val got = l.sumOf { it.got }
            val known = l.all { it.total > 0 }
            val total = l.sumOf { maxOf(it.total, 0L) }
            b.setContentTitle(if (l.size == 1) "正在下载 ${l[0].name}" else "正在下载 ${l.size} 个文件")
            b.setContentText(if (known) "${size(got)} / ${size(total)}" else "已下载 ${size(got)}")
            if (known && total > 0) b.setProgress(100, minOf(100, (got * 100 / total).toInt()), false) else b.setProgress(0, 0, true)
            return b.build()
        }

        /** 下完 / 没下成的通知（点一下打开“下载内容”）。 */
        fun finished(it: Item) {
            val ctx = Core.app
            try {
                channel(ctx)
                val b = Notification.Builder(ctx, CH).setAutoCancel(true).setContentIntent(tap(ctx))
                    .setSmallIcon(if (it.state == DONE) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error)
                    .setContentTitle(if (it.state == DONE) "下载完成" else "下载没成").setContentText(if (it.state == DONE) it.name else "${it.name}：${it.err}")
                nm(ctx).notify(it.id.hashCode(), b.build())
            } catch (e: Exception) { logw("下载通知没发出去：${e.message}") }
        }

        /** 按现在有没有文件在下，开 / 关前台服务、刷新进度。主线程调用。 */
        fun sync() {
            val ctx = Core.app
            val n = running()
            try {
                if (n > 0 && !on && !gaveUp) { on = true; ctx.startForegroundService(Intent(ctx, DownloadService::class.java)) }
                else if (n > 0) { if (svc != null) nm(ctx).notify(NID, progress(ctx)) }
                else { gaveUp = false; if (on) { on = false; svc?.stop() } }
            } catch (e: Exception) {
                // 开不了前台服务（比如 app 正好在后台）：下载照常进行，只是切走太久可能被系统停掉。这一批不再试
                on = false; gaveUp = true
                logw("下载保活没开起来：${e.javaClass.simpleName} ${e.message}")
            }
        }
    }
}

/** 下载时的前台服务：只为了让系统别在下载中途把 app 收走（见 [Downloads.Keep]）。 */
class DownloadService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val n = Downloads.Keep.progress(this)
            if (Build.VERSION.SDK_INT >= 29) startForeground(Downloads.Keep.NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(Downloads.Keep.NID, n)
            logi("下载保活已开")
        } catch (e: Exception) {
            logw("下载保活没开起来：${e.javaClass.simpleName} ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        Downloads.Keep.svc = this
        if (Downloads.running() == 0) stop()
        return START_NOT_STICKY
    }

    fun stop() {
        if (Downloads.Keep.svc === this) Downloads.Keep.svc = null
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (e: Exception) { }
        stopSelf()
    }

    /** 安卓 15 起这类前台服务一天最多跑 6 小时，到点系统来叫；不停就会被当成出错。 */
    override fun onTimeout(startId: Int, fgsType: Int) { logw("下载保活到时间了，系统让停"); stop() }

    override fun onDestroy() {
        if (Downloads.Keep.svc === this) Downloads.Keep.svc = null
        super.onDestroy()
    }
}

/** 网页的“选择文件”（上传）：系统选出来的是 content:// 地址，内核只认文件路径，所以先抄一份到缓存目录再交给网页；隔天清掉。 */
object Uploads {
    private fun dir(ctx: Context) = File(ctx.cacheDir, "uploads")

    fun copy(ctx: Context, u: Uri): Uri? = try {
        var name = ""
        try { ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) name = c.getString(0) ?: "" } } catch (e: Exception) { }
        if (name.isEmpty()) name = u.lastPathSegment?.substringAfterLast('/') ?: ""
        name = name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").ifEmpty { "file" }
        val f = File(File(dir(ctx), randomHex(4)), name)
        f.parentFile?.mkdirs()
        (ctx.contentResolver.openInputStream(u) ?: throw IOException("读不出来")).use { i -> f.outputStream().use { o -> i.copyTo(o, 64 * 1024) } }
        Uri.fromFile(f)
    } catch (e: Exception) { logw("选的文件读不出来：${e.message}"); null }

    /** 启动时清掉一天前抄的。 */
    fun sweep(ctx: Context) {
        val old = System.currentTimeMillis() - 24 * 3600 * 1000L
        dir(ctx).listFiles()?.forEach { d -> if (d.lastModified() < old) d.deleteRecursively() }
    }
}
