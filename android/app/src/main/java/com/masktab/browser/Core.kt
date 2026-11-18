package com.masktab.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebExtensionController
import org.mozilla.geckoview.WebRequestError
import org.mozilla.geckoview.WebResponse
import java.io.File
import java.net.URLEncoder

// 浏览器核心：GeckoRuntime、内置扩展、每个实例的一组标签页。放在进程级单例里，Activity 重建时会话不丢。
//
// 多实例 = 每个实例一个 GeckoSessionSettings.contextId("mt-<id>") 容器：Cookie、本地存储、缓存互相隔离。
// 每个实例有自己的一组标签页；切换实例只是换显示的那组，后台实例的会话照常存活。

class Tab(val inst: String, val session: GeckoSession) {
    var url = ""
    var title = ""
    var progress = 100
    var canBack = false
    var canFwd = false
    /** 页面滚动位置（GeckoSession 的滚动回调给的；下拉刷新只在 0 时触发）。 */
    var scrollY = 0
    /** 网页最底下那一条的颜色（android/ext/bars.js 报的）；三键导航时导航栏涂成它（决策 UI-23 补充）。换页时清空。 */
    var pageColor: Int? = null
    /** 标签页切换器里的缩略图（切换器打开时截的，只留在内存里）。 */
    var thumb: android.graphics.Bitmap? = null
    /** 开这个标签页之前显示的是哪个标签页（这个标签页如果只是为了下载一个文件而开的，下载一开始就切回去，见 Core 的 onExternalResponse）。 */
    var opener: Tab? = null
}

/**
 * 最近访问（新标签页“最近访问”、三点菜单“历史记录”）：浏览器外壳的事，按实例分开记，每个实例最多 60 条，存 files/recent.json。
 * 电脑版用内核自己的历史记录（每个实例是独立的用户目录，天然分开）。
 */
object Recent {
    class Visit(val url: String, var title: String, var at: Long)
    private val map = HashMap<String, ArrayDeque<Visit>>()
    private val file get() = File(Core.app.filesDir, "recent.json")
    private var loaded = false
    private fun load() {
        if (loaded) return
        loaded = true
        try {
            val j = JSONObject(file.readText())
            for (k in j.keys()) map[k] = ArrayDeque((j.optJSONArray(k)?.objects() ?: emptyList()).map { Visit(it.str("url"), it.str("title"), it.optLong("at")) })
        } catch (e: Exception) { }
    }
    private fun save() {
        val j = JSONObject()
        synchronized(map) { for ((k, l) in map) j.put(k, JSONArray(l.map { jsonOf("url" to it.url, "title" to it.title, "at" to it.at) })) }
        bg { writeAtomic(file, j.toString().toByteArray()) }
    }
    fun add(inst: String, url: String, title: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        load()
        synchronized(map) {
            val l = map.getOrPut(inst) { ArrayDeque() }
            l.removeAll { it.url == url }
            l.addFirst(Visit(url, title, System.currentTimeMillis()))
            while (l.size > 60) l.removeLast()
        }
        save()
    }
    fun title(inst: String, url: String, title: String) {
        load()
        synchronized(map) { map[inst]?.firstOrNull { it.url == url }?.let { if (title.isNotEmpty() && it.title != title) it.title = title else return } ?: return }
        save()
    }
    fun list(inst: String, max: Int): JSONArray { load(); return synchronized(map) { JSONArray((map[inst] ?: ArrayDeque()).take(max).map { jsonOf("url" to it.url, "title" to it.title, "at" to it.at) }) } }
    fun clear(inst: String) { load(); synchronized(map) { map.remove(inst) }; save() }
}

/** Activity 实现它来刷新界面。 */
interface CoreUi {
    fun onTabsChanged()
    fun onTabUpdated(t: Tab)
    fun openSheet(route: String, full: Boolean)
    fun closeSheet()
    fun showPopup(session: GeckoSession)
    fun toast(msg: String)
    /** 网页上长按链接 / 图片 / 视频。 */
    fun contextMenu(t: Tab, e: GeckoSession.ContentDelegate.ContextElement) {}
    /** 一个下载开始了，或者结束了（看 it.state）。 */
    fun onDownload(it: Downloads.Item) {}
    /** 页面（内置页面 / 新标签页）报上来：盖了一层遮罩（dim）、底部有表单（sheet），状态栏和导航栏跟着变色（决策 UI-4）。 */
    fun pageBars(src: String, dim: Boolean, sheet: Boolean) {}
    /** 一个标签页加载完了（下拉刷新收起指示器用）。 */
    fun onPageStopped(t: Tab) {}
    val prompts: Prompts?
}

object Core {
    const val EXT_ID = "masktab@halou367"
    const val NATIVE = "masktab"

    lateinit var app: Context
    var runtime: GeckoRuntime? = null
    var ext: WebExtension? = null
    var bgPort: WebExtension.Port? = null
    var ui: CoreUi? = null
    var started = false

    /** 实例 id → 标签页（按打开顺序）；实例 id → 当前标签页。 */
    val tabs = HashMap<String, MutableList<Tab>>()
    val active = HashMap<String, Tab>()
    /** 用户扩展的工具栏按钮（点了弹出它的弹窗）。 */
    val actions = HashMap<String, WebExtension.Action>()

    fun init(ctx: Context) {
        if (::app.isInitialized) return
        app = ctx.applicationContext
        Diag.install(app)
        CoreProc.init(app)
        Host.init(app)
        Host.onChange = { old -> onState(old) }
        bg { Uploads.sweep(app) }
        CoreProc.onDied = { coreDied() }
    }

    // ---------- 内核 ----------

    /** Gecko 偏好：开指纹保护；WebRTC 只走代理、不暴露本机地址；关 Service Worker（它的请求不带标签页，没法按实例分流，见 docs/android.md）。 */
    private fun writeGeckoConfig(): String {
        val f = File(app.filesDir, "geckoview-config.yaml")
        // 人机验证诊断（决策 A-9）可以把这两项暂时还原成内核默认；重启 app 生效
        val fpp = "fpp" !in Host.fpOff
        val sw = "sw" in Host.fpOff
        f.writeText(
            """
            prefs:
              privacy.fingerprintingProtection: $fpp
              media.peerconnection.ice.proxy_only_if_behind_proxy: true
              media.peerconnection.ice.default_address_only: true
              media.peerconnection.ice.no_host: true
              network.proxy.socks_remote_dns: true
              dom.serviceWorkers.enabled: $sw
              signon.rememberSignons: false
            """.trimIndent() + "\n",
        )
        return f.path
    }

    fun ensureRuntime(): GeckoRuntime {
        runtime?.let { return it }
        val s = GeckoRuntimeSettings.Builder()
            .configFilePath(writeGeckoConfig())
            .consoleOutput(true)
            .loginAutofillEnabled(false)
            .build()
        val rt = GeckoRuntime.create(app, s)
        rt.settings.setFingerprintingProtection("fpp" !in Host.fpOff)
        runtime = rt
        applyLocale()
        rt.webExtensionController.setPromptDelegate(installPrompt)
        return rt
    }

    /** 装内置扩展（assets/ext，由构建合成）。回调在主线程。 */
    fun ensureExt(done: (String?) -> Unit) {
        val rt = ensureRuntime()
        rt.webExtensionController.ensureBuiltIn("resource://android/assets/ext/", EXT_ID).accept({ e ->
            if (e == null) { done("内置扩展没有装上"); return@accept }
            ext = e
            e.setMessageDelegate(extDelegate, NATIVE)
            done(null)
        }, { err -> done("内置扩展安装失败：${err?.message}") })
    }

    val baseUrl: String get() = ext?.metaData?.baseUrl?.let { if (it.endsWith("/")) it else "$it/" } ?: ""

    fun pageUrl(route: String) = "${baseUrl}app.html#$route"

    /** 新标签页 / 引导页：先让扩展记下这个标签页属于哪个实例，再跳到 go（见 ext/newtab.js）。 */
    fun bootUrl(inst: String, go: String?): String =
        "${baseUrl}newtab.html#inst=$inst" + (if (!go.isNullOrEmpty()) "&go=" + URLEncoder.encode(go, "UTF-8") else "")

    fun isInternal(url: String) = baseUrl.isNotEmpty() && url.startsWith(baseUrl)

    // ---------- 标签页 ----------

    fun tabsOf(inst: String): MutableList<Tab> = tabs.getOrPut(inst) { mutableListOf() }

    fun curTab(): Tab? = active[Host.current]

    private fun newSession(i: Inst): GeckoSession {
        val s = GeckoSession(
            GeckoSessionSettings.Builder()
                .contextId(i.contextId)
                .userAgentOverride(Fp.userAgent(i.seed))
                .useTrackingProtection("tp" !in Host.fpOff)
                .suspendMediaWhenInactive(true)
                .build(),
        )
        return s
    }

    private fun attach(t: Tab) {
        val s = t.session
        s.navigationDelegate = Nav(t)
        s.progressDelegate = Progress(t)
        s.contentDelegate = Content(t)
        s.promptDelegate = PromptBridge
        s.scrollDelegate = Scroll(t)
        s.open(ensureRuntime())
        ext?.let { s.webExtensionController.setMessageDelegate(it, sessionMsg(t.inst, t), NATIVE) }
    }

    /** 在实例里开一个标签页。url 为空 = 新标签页。 */
    fun openTab(instId: String, url: String? = null, activate: Boolean = true, raw: Boolean = false): Tab? {
        val i = Host.get(instId) ?: return null
        val t = Tab(i.id, newSession(i))
        t.opener = active[i.id]
        attach(t)
        tabsOf(i.id).add(t)
        t.session.loadUri(if (raw && url != null) url else bootUrl(i.id, url))
        if (activate) active[i.id] = t
        ui?.onTabsChanged()
        saveTabs()
        return t
    }

    // ---------- app 发起的下载（长按“保存图片 / 下载链接”、三点菜单“下载此页”；决策 A-14）----------
    // 内核没有“把这个网址下下来”的接口。做法：在这个实例里开一个不进标签列表的会话去打开这个网址（经引导页登记到实例，和普通标签页一样），
    // 引导页告诉内置扩展“这个标签页接下来那一次是下载”（地址里的 dl=<编号>），扩展把那一次的响应标成附件，
    // 内核就不显示它、当下载交回来（onExternalResponse）。请求是内核自己发的：线路、Cookie、UA、TLS 特征都和网页一样。
    // 服务器回了错误、连不上：扩展报回来（Bridge：POST /ui/dl-fail）；90 秒什么都没等到也算失败。
    private class DlJob(val n: String, val inst: String, val url: String, val from: String, val session: GeckoSession) { var got = false }
    private val dlJobs = HashMap<String, DlJob>()

    /** 在主线程调用。ref = 要带的来源页（按浏览器默认规则算好的；没有就不带）。 */
    fun download(i: Inst, url: String, from: String, ref: String?) {
        val j = DlJob(randomHex(6), i.id, url, from, newSession(i))
        dlJobs[j.n] = j
        val s = j.session
        s.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
                if (j.got || dlJobs[j.n] !== j) return
                j.got = true
                Downloads.fromResponse(j.inst, response, j.from) { dlEnd(j) }
            }
        }
        s.promptDelegate = PromptBridge // 下载地址要用户名密码时照样能问
        s.open(ensureRuntime())
        s.loadUri(bootUrl(i.id, url) + "&dl=" + j.n + (if (!ref.isNullOrEmpty()) "&ref=" + URLEncoder.encode(ref, "UTF-8") else ""))
        logi("下载：请内核去取 实例 ${i.id} ${url.take(160)}")
        mainHandler.postDelayed({ if (!j.got) dlFail(j.n, "等了 90 秒没有回应") }, 90_000)
    }

    /** 内置扩展报来的：这次下载没成（服务器回了错误、连不上）。 */
    fun dlFail(n: String, err: String) = ui {
        val j = dlJobs[n]
        if (j != null && !j.got) { j.got = true; Downloads.failed(j.inst, j.url, j.from, err); dlEnd(j) }
    }

    private fun dlEnd(j: DlJob) {
        if (dlJobs.remove(j.n) == null) return
        try { j.session.close() } catch (e: Exception) { }
        logi("下载用的会话已关掉")
    }

    /** onNewSession（网页 window.open / target=_blank）：同一实例里开新标签，保留 opener 关系。 */
    private fun popupTab(instId: String, opener: Tab? = null): GeckoSession? {
        val i = Host.get(instId) ?: return null
        val t = Tab(i.id, newSession(i))
        t.opener = opener
        // 不在这里 open：GeckoView 要求 onNewSession 返回未打开的会话，由它来打开
        t.session.navigationDelegate = Nav(t)
        t.session.progressDelegate = Progress(t)
        t.session.contentDelegate = Content(t)
        t.session.promptDelegate = PromptBridge
        t.session.scrollDelegate = Scroll(t)
        ext?.let { t.session.webExtensionController.setMessageDelegate(it, sessionMsg(t.inst, t), NATIVE) }
        tabsOf(i.id).add(t)
        active[i.id] = t
        mainHandler.post { ui?.onTabsChanged() }
        return t.session
    }

    /** 最近关闭的标签页（三点菜单 → 最近打开的标签页），最多 10 个，只在内存里。 */
    val closed = ArrayDeque<Pair<String, String>>() // 实例 id → 网址

    fun closeTab(t: Tab) {
        if (t.url.startsWith("http")) { closed.addFirst(t.inst to t.url); while (closed.size > 10) closed.removeLast() }
        val l = tabsOf(t.inst)
        val k = l.indexOf(t)
        l.remove(t)
        t.session.close()
        if (active[t.inst] == t) {
            if (l.isNotEmpty()) active[t.inst] = l[minOf(k, l.size - 1)] else active.remove(t.inst)
        }
        if (l.isEmpty() && t.inst == Host.current) openTab(t.inst) else ui?.onTabsChanged()
        saveTabs()
    }

    fun selectTab(t: Tab) { active[t.inst] = t; ui?.onTabsChanged() }

    /** 切到另一个实例：显示它的标签组；它还没有标签就开一个新标签页。实例还没启动（代理没备好）时先请核心服务启动它，就绪后再切。 */
    fun switchTo(id: String) {
        val i = Host.get(id) ?: return
        if (!i.running) { open(id); return }
        Host.saveCurrent(i.id)
        if (tabsOf(i.id).isEmpty()) openTab(i.id) else ui?.onTabsChanged()
        pushState()
    }
    /** 待切过去的实例（正在启动），和开始等的时间。 */
    private var pendingOpen: String? = null
    private var pendingAt = 0L
    /** 启动一个实例（核心服务：选线、写 mihomo 配置、探出口），就绪后切过去。 */
    fun open(id: String) {
        val i = Host.get(id) ?: return
        if (i.running) { switchTo(id); return }
        pendingOpen = id; pendingAt = System.currentTimeMillis()
        ui?.toast("正在打开 #${i.no}…")
        launch(id)
    }
    /** 请核心服务启动实例（不切换）。 */
    fun launch(id: String) = bg {
        try { CoreProc.json("POST", "/api/instances/$id/launch"); Host.refresh() } catch (e: Exception) {
            logw("启动实例失败：${e.message}")
            ui { if (pendingOpen == id) { pendingOpen = null; ui?.toast("打不开：${e.message}") } }
        }
    }
    private fun closeAll(id: String) {
        tabsOf(id).toList().forEach { it.session.close() }
        tabs.remove(id)
        active.remove(id)
    }
    /**
     * 关闭一个实例的全部标签（会话结束，数据保留）。当前显示的实例关完马上给它开一个新标签页（代理不停）；
     * 别的实例同时请核心服务停掉它（它在 mihomo 里的入站一并拿掉）。
     */
    fun stopInst(id: String) {
        closeAll(id)
        if (id == Host.current) openTab(id) else {
            ui?.onTabsChanged()
            bg { try { CoreProc.json("POST", "/api/instances/$id/stop"); Host.refresh() } catch (e: Exception) { logw("停止实例失败：${e.message}") } }
        }
        saveTabs()
    }
    fun reloadInst(id: String) { tabsOf(id).forEach { it.session.reload() } }
    /** 删除实例之前：关会话、清容器数据。实例本身（连同它的账号密码）由核心服务删，删完状态里没有它了，[onState] 会换到别的实例。 */
    fun dropInst(id: String) {
        closeAll(id)
        Downloads.dropInst(id)
        dlJobs.values.filter { it.inst == id }.forEach { dlEnd(it) }
        runtime?.storageController?.clearDataForSessionContext("mt-$id")
        ui?.onTabsChanged()
        saveTabs()
    }
    /** 换了种子（换指纹）后：UA 要在新会话上才生效，所以把这个实例的标签按原网址重开。 */
    fun refreshIdentity(id: String) {
        val i = Host.get(id) ?: return
        val urls = tabsOf(id).map { it.url }
        closeAll(id)
        pushState()
        if (urls.isEmpty()) { if (id == Host.current) openTab(id) } else urls.forEach { openTab(i.id, it.takeUnless { u -> isInternal(u) || u.isEmpty() }) }
        ui?.onTabsChanged()
    }
    private val tabsFile get() = File(app.filesDir, "tabs.json")
    fun saveTabs() {
        val j = JSONObject()
        for ((id, l) in tabs) {
            if (l.isEmpty()) continue
            val urls = JSONArray(l.map { if (isInternal(it.url)) "" else it.url })
            j.put(id, jsonOf("urls" to urls, "active" to l.indexOf(active[id])))
        }
        for ((id, o) in pendingRestore) if (!j.has(id)) j.put(id, o) // 还没来得及恢复的也留着
        bg { writeAtomic(tabsFile, j.toString().toByteArray()) }
    }
    /** 等实例启动好再恢复的标签页：实例 id → {urls, active}。 */
    private val pendingRestore = HashMap<String, JSONObject>()
    private fun restoreInst(id: String, o: JSONObject) {
        val urls = o.optJSONArray("urls")?.strings() ?: return
        urls.forEach { openTab(id, it.ifEmpty { null }, activate = false) }
        val l = tabsOf(id)
        if (l.isNotEmpty()) active[id] = l[o.optInt("active", 0).coerceIn(0, l.size - 1)]
    }
    /** 启动时恢复上次的标签页（每个都经引导页，先登记实例再加载网址）。还没启动的实例先请核心服务启动，就绪后再恢复。 */
    fun restoreTabs() {
        val j = try { JSONObject(tabsFile.readText()) } catch (e: Exception) { JSONObject() }
        for (id in j.keys()) {
            val i = Host.get(id) ?: continue
            val o = j.optJSONObject(id) ?: continue
            if ((o.optJSONArray("urls")?.length() ?: 0) == 0) continue
            if (i.running) restoreInst(id, o) else { pendingRestore[id] = o; launch(id) }
        }
        val cur = Host.cur()
        if (cur != null) {
            Host.saveCurrent(cur.id)
            if (tabsOf(cur.id).isEmpty() && !pendingRestore.containsKey(cur.id)) { if (cur.running) openTab(cur.id) else open(cur.id) }
        }
        ui?.onTabsChanged()
    }

    // ---------- 跟着核心服务的状态走 ----------

    /** 核心服务的状态变了（主线程）：把 GeckoView 这边对齐。 */
    private fun onState(old: List<Inst>) {
        if (!started) return
        val now = Host.insts
        // 实例被删了：关掉它的标签
        for (id in tabs.keys.toList()) if (Host.get(id) == null) closeAll(id)
        for (id in pendingRestore.keys.toList()) if (Host.get(id) == null) pendingRestore.remove(id)
        // 换了指纹：按新种子重开这个实例的标签
        for (i in now) {
            val o = old.firstOrNull { it.id == i.id } ?: continue
            if (o.seed != i.seed && tabsOf(i.id).isNotEmpty()) { logi("实例 #${i.no} 换了指纹，重开标签页"); refreshIdentity(i.id) }
        }
        // 等启动的：标签页恢复、切换
        for ((id, o) in pendingRestore.toMap()) if (Host.get(id)?.running == true) { pendingRestore.remove(id); restoreInst(id, o) }
        pendingOpen?.let { id ->
            val i = Host.get(id)
            when {
                i == null -> pendingOpen = null
                i.running -> { pendingOpen = null; switchTo(id) }
                !i.starting && i.error.isNotEmpty() -> { pendingOpen = null; ui?.toast("#${i.no} 打不开：${i.error}") }
                System.currentTimeMillis() - pendingAt > 45000 -> { pendingOpen = null; ui?.toast("#${i.no} 一直没启动好") }
            }
        }
        // 当前显示的实例没了（被删）：换到第一个；一个都不剩就新建
        if (Host.get(Host.current) == null && pendingOpen == null) {
            val first = now.firstOrNull()
            if (first != null) { Host.saveCurrent(first.id); if (first.running) switchTo(first.id) else open(first.id) } else createInst()
        }
        pushState()
        ui?.onTabsChanged()
    }
    @Volatile private var creating = false
    /** 新建一个实例并切过去（核心服务建好后自己启动它）。 */
    fun createInst() {
        if (creating) return
        creating = true
        bg {
            try {
                val r = CoreProc.json("POST", "/api/instances", JSONObject())
                val id = r.str("id")
                Host.refresh()
                logi("新建实例 #${Host.get(id)?.no ?: "?"}")
                ui { Host.saveCurrent(id); pendingOpen = id; pendingAt = System.currentTimeMillis(); Host.get(id)?.let { if (it.running) switchTo(id) } }
            } catch (e: Exception) { logw("新建实例失败：${e.message}"); ui { ui?.toast("新建实例失败：${e.message}") } } finally { creating = false }
        }
    }
    /** 等某个实例启动好再切过去（新建、导入之后用）。 */
    fun openWhenReady(id: String) { pendingOpen = id; pendingAt = System.currentTimeMillis(); Host.get(id)?.let { if (it.running) { pendingOpen = null; switchTo(id) } } }

    /** 核心服务被系统杀掉（安卓 12+ 会清理 app 的子进程）或自己退出：拉起来，把开着标签页的实例重新接上。30 秒内最多一次。 */
    private var lastRevive = 0L
    private fun coreDied() {
        if (!started) return
        val t = System.currentTimeMillis()
        if (t - lastRevive < 30000) { ui { ui?.toast("核心服务又退出了，请在“设置”里复制诊断信息") }; return }
        lastRevive = t
        Thread.sleep(800)
        if (!CoreProc.start()) { ui { ui?.toast("核心服务没有起来：${CoreProc.lastError}") }; return }
        Host.refresh()
        val open = tabs.filter { it.value.isNotEmpty() }.keys.toList()
        for (id in open) try { CoreProc.json("POST", "/api/instances/$id/launch") } catch (e: Exception) { logw("重新接上实例 $id 失败：${e.message}") }
        Host.refresh()
    }

    // ---------- 诊断 ----------
    /** 扩展页面报上来的错误（最近 30 条），连同版本、核心服务状态和日志一起给“复制诊断信息”。 */
    private val pageErrors = ArrayDeque<String>()
    fun pageLog(msg: String) {
        logw("页面报错：$msg")
        synchronized(pageErrors) { pageErrors.addLast(java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date()) + " " + msg.take(500)); while (pageErrors.size > 30) pageErrors.removeFirst() }
    }
    fun diag(): String {
        val sb = StringBuilder()
        val pi = try { app.packageManager.getPackageInfo(app.packageName, 0) } catch (e: Exception) { null }
        sb.append("MaskTab ${pi?.versionName ?: "?"} · Android ${android.os.Build.VERSION.RELEASE}（API ${android.os.Build.VERSION.SDK_INT}） · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · ${android.os.Build.SUPPORTED_ABIS.firstOrNull()}\n")
        sb.append("内核 ${GeckoSession.getDefaultUserAgent().substringAfter("rv:").substringBefore(")")} · 内置扩展 ${if (ext != null) "已装" else "未装"} · 后台连接 ${if (bgPort != null) "有" else "无"}\n")
        sb.append("核心服务 ${if (!CoreProc.installed) "未安装" else if (CoreProc.running) "运行中 ${Host.version}" else "未运行"}${if (CoreProc.lastError.isNotEmpty()) "（${CoreProc.lastError}）" else ""}" +
            " · mihomo ${if (!CoreProc.mihomoInstalled) "未安装" else if (Host.mihomoOk) "运行中 ${Host.mihomoVersion}" else "未运行"}${if (Host.coreError.isNotEmpty()) "（${Host.coreError}）" else ""}" +
            " · 订阅 ${if (Host.subs.isEmpty()) "无" else Host.subs.joinToString("、") { "…$it…" }} · 入口 / 节点 ${Host.nodeCount} 个\n")
        if (Host.vaultKeyError.isNotEmpty()) sb.append("密码库：${Host.vaultKeyError}\n")
        for (i in Host.insts) {
            sb.append("#${i.no} ${if (!i.on) "直连" else "代理"} · ${if (i.running) "运行中" else if (i.starting) "启动中" else "未启动"} · 端口 ${i.port} · 出口 ${if (i.country.isEmpty()) "未知" else i.country + " " + i.ip.replace(Regex("\\.\\d+\\.\\d+$"), ".*.*")}" +
                " · 标签 ${tabsOf(i.id).size}${if (i.id == Host.current) " · 当前" else ""}${if (i.error.isNotEmpty()) " · 问题：${i.error}" else ""}\n")
        }
        val errs = synchronized(pageErrors) { pageErrors.toList() }
        if (errs.isNotEmpty()) sb.append("—— 页面报错 ——\n").append(errs.joinToString("\n")).append("\n")
        val log = CoreProc.logTail(2500).trim()
        if (log.isNotEmpty()) sb.append("—— 核心服务日志 ——\n").append(log).append("\n")
        val ml = CoreProc.mihomoLogTail(1200).trim()
        if (ml.isNotEmpty()) sb.append("—— mihomo 日志 ——\n").append(ml).append("\n")
        return sb.toString()
    }

    // ---------- 与内置扩展通信 ----------

    /** 交给扩展后台的每实例参数：端口、指纹种子、时区、语言。 */
    fun extState(): JSONObject {
        val arr = JSONArray()
        for (i in Host.insts) arr.put(Fp.cfg(i))
        return jsonOf("t" to "state", "insts" to arr, "searchUrl" to Host.searchUrl, "off" to JSONArray(Host.fpOff.toList()))
    }
    /** 重启整个 app（人机验证诊断改了内核偏好之后用）：先请系统重新打开主界面，再结束本进程；核心服务随输入管道关闭自己退出。 */
    fun restartApp() {
        val i = app.packageManager.getLaunchIntentForPackage(app.packageName) ?: return
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
        app.startActivity(i)
        Runtime.getRuntime().exit(0)
    }

    fun pushState() = ui { applyLocale(); try { bgPort?.postMessage(extState()) } catch (e: Exception) { logw("推送状态失败", e) } }

    /**
     * 网页语言（决策 A-10）：用内核原生设置，按当前显示的实例走。内核给出的 navigator.language(s)、Worker 里的 navigator、
     * Accept-Language 请求头、Intl 默认语言都跟着变，彼此一致（JS 注入改不到 Worker，会被 Turnstile 判 600010）。
     * 代价：GeckoRuntime 全局只有一份，后台实例的标签页也会跟着当前实例的语言；GeckoView 还会把系统语言追加在后面（computeAcceptLanguages）。
     */
    private var appliedLang = "" // "" = 系统语言（启动时内核本来就是系统语言，不用设）
    fun applyLocale() {
        val rt = runtime ?: return
        val l = Host.cur()?.lang?.takeIf { it.isNotEmpty() && "lang" !in Host.fpOff } ?: ""
        if (l == appliedLang) return
        appliedLang = l
        // 回到系统语言时不能传 null：GeckoView 160 的 GeckoViewStartup 收到 null 只重算 intl.accept_languages，
        // 不动 Services.locale.requestedLocales，Intl 默认语言会停在上一个实例上，又成了不一致。所以显式传系统语言列表。
        // 带上基础语言（ja-JP → ja-JP, ja），和以前改请求头时的 "ja-JP,ja" 一致；GeckoView 还会在后面追加系统语言。
        val locs = if (l.isNotEmpty()) listOf(l, l.substringBefore('-')).distinct() else {
            val ll = android.os.LocaleList.getDefault()
            (0 until ll.size()).map { ll.get(it).toLanguageTag() }.ifEmpty { listOf(java.util.Locale.getDefault().toLanguageTag()) }
        }
        try { rt.settings.setLocales(locs.toTypedArray()); logi("网页语言 → ${locs.joinToString(",")}${if (l.isEmpty()) "（系统）" else ""}") } catch (e: Exception) { logw("设置网页语言失败", e) }
    }

    /**
     * 扩展后台与扩展页面（菜单、管理页、新标签页）的请求：形如 {m, p, b}，见 Bridge。
     * 回复一律是 JSON 字符串：GeckoView 把回复交回 JS 时不认 JSONObject（CI 里报 “Invalid event data for callback”），JS 那边再 JSON.parse。
     */
    private val extDelegate = object : WebExtension.MessageDelegate {
        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? {
            val r = GeckoResult<Any>()
            val j = message as? JSONObject ?: return GeckoResult.fromValue(jsonOf("error" to "格式不对").toString())
            Bridge.handle(j) { out -> r.complete(out) }
            return r
        }

        override fun onConnect(port: WebExtension.Port) {
            bgPort = port
            port.setDelegate(object : WebExtension.PortDelegate {
                override fun onPortMessage(message: Any, port: WebExtension.Port) {}
                override fun onDisconnect(port: WebExtension.Port) { if (bgPort == port) bgPort = null }
            })
            port.postMessage(extState())
        }
    }

    /**
     * 会话级的消息：GeckoView 把“来自某个会话”的原生消息交给这个会话自己的 delegate（没设就一直挂着，CI 里实测），
     * 包括这个会话里的内容脚本、以及在会话里打开的扩展页面（新标签页、实例菜单、管理页）。
     * - 内容脚本只能要本实例参数（hello）；会话本身就说明了它属于哪个实例，网页伪造不了。
     * - 扩展页面走完整的 Bridge；没写 inst 的请求按这个会话的实例算。
     */
    fun sessionMsg(instId: String?, tab: Tab? = null) = object : WebExtension.MessageDelegate {
        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? {
            val j = message as? JSONObject ?: return GeckoResult.fromValue(jsonOf("error" to "格式不对").toString())
            // 网页底部的颜色（bars.js）：只记在这个会话自己的标签页上，网页只能改自己那一页的导航栏颜色
            if (j.str("t") == "color") {
                val c = try { android.graphics.Color.parseColor(j.str("c")) } catch (e: Exception) { null }
                if (tab != null && c != null && tab.pageColor != c) { tab.pageColor = c; mainHandler.post { ui?.onTabUpdated(tab) } }
                return GeckoResult.fromValue("{}")
            }
            if (j.str("t") == "hello") {
                val i = Host.get(instId) ?: return GeckoResult.fromValue(jsonOf("error" to "不是实例标签页").toString())
                return GeckoResult.fromValue(Fp.cfg(i).toString())
            }
            if (sender.environmentType != WebExtension.MessageSender.ENV_TYPE_EXTENSION) return GeckoResult.fromValue(jsonOf("error" to "内容脚本不能调用这个接口").toString())
            if (instId != null && !j.has("inst")) j.put("inst", instId)
            val r = GeckoResult<Any>()
            Bridge.handle(j) { out -> r.complete(out) }
            return r
        }
    }

    // ---------- 会话回调 ----------

    private class Nav(val t: Tab) : GeckoSession.NavigationDelegate {
        override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
            if ((url ?: "") != t.url) t.pageColor = null
            t.url = url ?: ""
            ui?.onTabUpdated(t)
            saveTabs()
        }
        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) { t.canBack = canGoBack }
        override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) { t.canFwd = canGoForward }
        override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession>? = popupTab(t.inst, t)?.let { GeckoResult.fromValue(it) }
        override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
            if (Addons.isXpi(request.uri)) { Addons.install(request.uri); return GeckoResult.deny() }
            return null
        }
        override fun onLoadError(session: GeckoSession, uri: String?, error: WebRequestError): GeckoResult<String>? {
            // 记日志（CI 冒烟测试用它确认“节点不通时页面打不开、没有直连”），错误页仍用内核自带的
            logi("加载失败 $uri 实例 ${t.inst} 类别 ${error.category} 代码 ${error.code}")
            return null
        }
    }

    private class Progress(val t: Tab) : GeckoSession.ProgressDelegate {
        override fun onProgressChange(session: GeckoSession, progress: Int) { t.progress = progress; ui?.onTabUpdated(t) }
        override fun onPageStart(session: GeckoSession, url: String) { t.progress = 5; t.scrollY = 0; ui?.onTabUpdated(t) }
        override fun onPageStop(session: GeckoSession, success: Boolean) {
            t.progress = 100; ui?.onTabUpdated(t); ui?.onPageStopped(t)
            if (success) Recent.add(t.inst, t.url, t.title)
        }
    }

    private class Scroll(val t: Tab) : GeckoSession.ScrollDelegate {
        override fun onScrollChanged(session: GeckoSession, scrollX: Int, scrollY: Int) { t.scrollY = scrollY }
    }

    private class Content(val t: Tab) : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) { t.title = title ?: ""; ui?.onTabUpdated(t); Recent.title(t.inst, t.url, t.title) }
        override fun onCloseRequest(session: GeckoSession) { closeTab(t) }
        override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
            val type = response.headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value ?: ""
            if (type.contains("x-xpinstall")) { Addons.install(response.uri); return }
            // 下载（决策 A-14）：内容是内核在这个实例的线路上取回来的，交给 Downloads 存进系统的下载文件夹。
            // 这个标签页如果只是为了这次下载开的（新窗口打开的下载链接、从外面点进来的下载地址），它会一直是空白的：
            // 先切回原来那个标签页，等下完了再把它关掉（下载途中关会话怕把内核那头的连接一起掐掉，所以等下完）。
            val spare = spareTab(t)
            if (spare && active[t.inst] === t) t.opener?.takeIf { it !== t && tabsOf(t.inst).contains(it) }?.let { selectTab(it) }
            Downloads.fromResponse(t.inst, response, if (spare) t.opener?.url ?: "" else t.url) {
                if (spare && spareTab(t) && tabsOf(t.inst).contains(t)) { closeTab(t); logi("下载用的空标签页已关掉") }
            }
        }
        override fun onContextMenu(session: GeckoSession, screenX: Int, screenY: Int, element: GeckoSession.ContentDelegate.ContextElement) {
            if (t.url.startsWith("http")) ui?.contextMenu(t, element)
        }
        override fun onCrash(session: GeckoSession) { ui?.toast("页面崩溃了，已重新加载"); session.close(); attachAgain(t) }
        override fun onKill(session: GeckoSession) { attachAgain(t) }
    }

    /** 这个标签页里什么网页都没有：刚开出来还是空的，或者停在引导页上等着跳转（跳过去的是个下载，所以永远不会变成网页）。 */
    private fun spareTab(t: Tab) = t.url.isEmpty() || t.url == "about:blank" || (isInternal(t.url) && t.url.contains("&go="))

    private fun attachAgain(t: Tab) {
        val url = t.url
        if (!t.session.isOpen) t.session.open(ensureRuntime())
        t.session.loadUri(bootUrl(t.inst, url.takeUnless { isInternal(it) }))
    }

    // ---------- 安装扩展的确认 ----------

    private val installPrompt = object : WebExtensionController.PromptDelegate {
        override fun onInstallPromptRequest(
            extension: WebExtension, permissions: Array<String>, origins: Array<String>, dataCollectionPermissions: Array<String>,
        ): GeckoResult<WebExtension.PermissionPromptResponse>? {
            val r = GeckoResult<WebExtension.PermissionPromptResponse>()
            val p = ui?.prompts
            if (p == null) { r.complete(WebExtension.PermissionPromptResponse(false, false, false)); return r }
            p.confirmInstall(extension, permissions, origins) { ok -> r.complete(WebExtension.PermissionPromptResponse(ok, false, false)) }
            return r
        }
    }
}

/** 会话的弹框（alert / confirm / prompt / 下拉选择）转给当前界面。 */
object PromptBridge : GeckoSession.PromptDelegate {
    override fun onAlertPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.AlertPrompt) = Core.ui?.prompts?.alert(prompt)
    override fun onButtonPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.ButtonPrompt) = Core.ui?.prompts?.button(prompt)
    override fun onTextPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.TextPrompt) = Core.ui?.prompts?.text(prompt)
    override fun onChoicePrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.ChoicePrompt) = Core.ui?.prompts?.choice(prompt)
    override fun onFilePrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.FilePrompt) = Core.ui?.prompts?.file(prompt)
    override fun onAuthPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.AuthPrompt) = Core.ui?.prompts?.auth(prompt)
    override fun onDateTimePrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.DateTimePrompt) = Core.ui?.prompts?.dateTime(prompt)
    override fun onColorPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.ColorPrompt) = Core.ui?.prompts?.color(prompt)
    override fun onSharePrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.SharePrompt) = Core.ui?.prompts?.share(prompt)
    override fun onRepostConfirmPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.RepostConfirmPrompt) = Core.ui?.prompts?.repost(prompt)
    override fun onBeforeUnloadPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.BeforeUnloadPrompt) =
        GeckoResult.fromValue(prompt.confirm(AllowOrDeny.ALLOW))
}
