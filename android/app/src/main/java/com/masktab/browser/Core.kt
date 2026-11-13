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
}

/** Activity 实现它来刷新界面。 */
interface CoreUi {
    fun onTabsChanged()
    fun onTabUpdated(t: Tab)
    fun openSheet(route: String, full: Boolean)
    fun closeSheet()
    fun showPopup(session: GeckoSession)
    fun toast(msg: String)
    val prompts: Prompts?
}

object Core {
    const val EXT_ID = "masktab@halou367"
    const val NATIVE = "masktab"

    lateinit var app: Context
    lateinit var store: Store
    lateinit var vault: Vault
    lateinit var mihomo: Mihomo
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
        store = Store(app.filesDir).apply { load() }
        vault = Vault(app.filesDir)
        mihomo = Mihomo(app)
    }

    // ---------- 内核 ----------

    /** Gecko 偏好：开指纹保护；WebRTC 只走代理、不暴露本机地址；关 Service Worker（它的请求不带标签页，没法按实例分流，见 docs/android.md）。 */
    private fun writeGeckoConfig(): String {
        val f = File(app.filesDir, "geckoview-config.yaml")
        f.writeText(
            """
            prefs:
              privacy.fingerprintingProtection: true
              media.peerconnection.ice.proxy_only_if_behind_proxy: true
              media.peerconnection.ice.default_address_only: true
              media.peerconnection.ice.no_host: true
              network.proxy.socks_remote_dns: true
              dom.serviceWorkers.enabled: false
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
        rt.settings.setFingerprintingProtection(true)
        rt.webExtensionController.setPromptDelegate(installPrompt)
        runtime = rt
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

    fun curTab(): Tab? = active[store.current]

    private fun newSession(i: Inst): GeckoSession {
        val s = GeckoSession(
            GeckoSessionSettings.Builder()
                .contextId(i.contextId)
                .userAgentOverride(Fp.userAgent(i.seed))
                .useTrackingProtection(true)
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
        s.open(ensureRuntime())
        ext?.let { s.webExtensionController.setMessageDelegate(it, sessionMsg(t.inst), NATIVE) }
    }

    /** 在实例里开一个标签页。url 为空 = 新标签页。 */
    fun openTab(instId: String, url: String? = null, activate: Boolean = true, raw: Boolean = false): Tab? {
        val i = store.get(instId) ?: return null
        val t = Tab(i.id, newSession(i))
        attach(t)
        tabsOf(i.id).add(t)
        t.session.loadUri(if (raw && url != null) url else bootUrl(i.id, url))
        if (activate) active[i.id] = t
        ui?.onTabsChanged()
        saveTabs()
        return t
    }

    /** onNewSession（网页 window.open / target=_blank）：同一实例里开新标签，保留 opener 关系。 */
    private fun popupTab(instId: String): GeckoSession? {
        val i = store.get(instId) ?: return null
        val t = Tab(i.id, newSession(i))
        // 不在这里 open：GeckoView 要求 onNewSession 返回未打开的会话，由它来打开
        t.session.navigationDelegate = Nav(t)
        t.session.progressDelegate = Progress(t)
        t.session.contentDelegate = Content(t)
        t.session.promptDelegate = PromptBridge
        ext?.let { t.session.webExtensionController.setMessageDelegate(it, sessionMsg(t.inst), NATIVE) }
        tabsOf(i.id).add(t)
        active[i.id] = t
        mainHandler.post { ui?.onTabsChanged() }
        return t.session
    }

    fun closeTab(t: Tab) {
        val l = tabsOf(t.inst)
        val k = l.indexOf(t)
        l.remove(t)
        t.session.close()
        if (active[t.inst] == t) {
            if (l.isNotEmpty()) active[t.inst] = l[minOf(k, l.size - 1)] else active.remove(t.inst)
        }
        if (l.isEmpty() && t.inst == store.current) openTab(t.inst) else ui?.onTabsChanged()
        saveTabs()
    }

    fun selectTab(t: Tab) { active[t.inst] = t; ui?.onTabsChanged() }

    /** 切到另一个实例：显示它的标签组；它还没有标签就开一个新标签页。 */
    fun switchTo(id: String) {
        val i = store.get(id) ?: return
        store.current = i.id
        store.save()
        if (tabsOf(i.id).isEmpty()) openTab(i.id) else ui?.onTabsChanged()
        if (store.rtOf(i.id).exit == null) probe(i.id)
        pushState()
    }

    /** 关闭一个实例的全部标签（会话结束，数据保留）。 */
    fun stopInst(id: String) {
        tabsOf(id).toList().forEach { it.session.close() }
        tabs.remove(id)
        active.remove(id)
        if (id == store.current) openTab(id) else ui?.onTabsChanged()
        saveTabs()
    }

    fun reloadInst(id: String) { tabsOf(id).forEach { it.session.reload() } }

    /** 删除实例：关会话、清容器数据、删它的密码。 */
    fun deleteInst(id: String) {
        val i = store.get(id) ?: return
        tabsOf(id).toList().forEach { it.session.close() }
        tabs.remove(id)
        active.remove(id)
        runtime?.storageController?.clearDataForSessionContext(i.contextId)
        try { vault.deleteInst(id) } catch (e: Exception) { logw("删除实例密码失败", e) }
        store.delete(id)
        if (tabsOf(store.current).isEmpty()) openTab(store.current)
        restartProxy()
        ui?.onTabsChanged()
        saveTabs()
    }

    /** 换了种子（换指纹）后：UA 要在新会话上才生效，所以把这个实例的标签按原网址重开。 */
    fun refreshIdentity(id: String) {
        val i = store.get(id) ?: return
        val urls = tabsOf(id).map { it.url }
        tabsOf(id).toList().forEach { it.session.close() }
        tabs.remove(id)
        active.remove(id)
        pushState()
        if (urls.isEmpty()) { if (id == store.current) openTab(id) } else urls.forEach { openTab(i.id, it.takeUnless { u -> isInternal(u) || u.isEmpty() }) }
        ui?.onTabsChanged()
    }

    fun saveTabs() {
        val j = JSONObject()
        for ((id, l) in tabs) {
            val urls = JSONArray(l.map { if (isInternal(it.url)) "" else it.url })
            j.put(id, jsonOf("urls" to urls, "active" to l.indexOf(active[id])))
        }
        bg { store.saveTabs(j) }
    }

    /** 启动时恢复上次的标签页（每个都经引导页，先登记实例再加载网址）。 */
    fun restoreTabs() {
        val j = store.loadTabs()
        for (id in j.keys()) {
            if (store.get(id) == null) continue
            val o = j.optJSONObject(id) ?: continue
            val urls = o.optJSONArray("urls")?.strings() ?: continue
            urls.forEach { openTab(id, it.ifEmpty { null }, activate = false) }
            val l = tabsOf(id)
            if (l.isNotEmpty()) active[id] = l[o.optInt("active", 0).coerceIn(0, l.size - 1)]
        }
        if (tabsOf(store.current).isEmpty()) openTab(store.current)
        ui?.onTabsChanged()
    }

    // ---------- 代理与出口 ----------

    /** 写配置并（重新）启动 mihomo，然后按实例选回节点、通知扩展。在后台线程调用。 */
    fun restartProxyBlocking(): Boolean {
        val ok = if (store.subUrl.isEmpty()) { mihomo.stop(); true } else mihomo.start(store)
        if (ok) mihomo.applySelections(store)
        ui { pushState() }
        return ok
    }

    fun restartProxy() = bg { restartProxyBlocking() }

    fun probe(id: String, done: (() -> Unit)? = null) {
        val i = store.get(id) ?: return
        val rt = store.rtOf(id)
        if (rt.probing) return
        rt.probing = true
        bg {
            val (ex, ms) = Probe.exit(i, mihomo.running)
            rt.probing = false
            if (ex != null) { rt.exit = ex; rt.latency = ms } else rt.latency = -1
            ui { pushState(); ui?.onTabsChanged(); done?.invoke() }
        }
    }

    // ---------- 与内置扩展通信 ----------

    /** 交给扩展后台的每实例参数：端口、是否直连、指纹种子、时区、语言。 */
    fun extState(): JSONObject {
        val arr = JSONArray()
        for (i in store.sorted()) {
            val ex = store.rtOf(i.id).exit
            arr.put(Fp.cfg(i, ex).put("port", i.port).put("direct", i.direct))
        }
        return jsonOf("t" to "state", "insts" to arr, "searchUrl" to store.searchUrl)
    }

    fun pushState() = ui { try { bgPort?.postMessage(extState()) } catch (e: Exception) { logw("推送状态失败", e) } }

    /**
     * 扩展后台与扩展页面（菜单、管理页、新标签页）的请求：形如 {m, p, b}，见 Bridge。
     * 回复一律是 JSON 字符串：GeckoView 把回复交回 JS 时不认 JSONObject（CI 里报 “Invalid event data for callback”），JS 那边再 JSON.parse。
     */
    private val extDelegate = object : WebExtension.MessageDelegate {
        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? {
            val r = GeckoResult<Any>()
            val j = message as? JSONObject ?: return GeckoResult.fromValue(jsonOf("error" to "格式不对").toString())
            Bridge.handle(j) { out -> r.complete(out.toString()) }
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
    fun sessionMsg(instId: String?) = object : WebExtension.MessageDelegate {
        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? {
            val j = message as? JSONObject ?: return GeckoResult.fromValue(jsonOf("error" to "格式不对").toString())
            if (j.str("t") == "hello") {
                val i = store.get(instId) ?: return GeckoResult.fromValue(jsonOf("error" to "不是实例标签页").toString())
                return GeckoResult.fromValue(Fp.cfg(i, store.rtOf(i.id).exit).put("port", i.port).put("direct", i.direct).toString())
            }
            if (sender.environmentType != WebExtension.MessageSender.ENV_TYPE_EXTENSION) return GeckoResult.fromValue(jsonOf("error" to "内容脚本不能调用这个接口").toString())
            if (instId != null && !j.has("inst")) j.put("inst", instId)
            val r = GeckoResult<Any>()
            Bridge.handle(j) { out -> r.complete(out.toString()) }
            return r
        }
    }

    // ---------- 会话回调 ----------

    private class Nav(val t: Tab) : GeckoSession.NavigationDelegate {
        override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
            t.url = url ?: ""
            ui?.onTabUpdated(t)
            saveTabs()
        }
        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) { t.canBack = canGoBack }
        override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) { t.canFwd = canGoForward }
        override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession>? = popupTab(t.inst)?.let { GeckoResult.fromValue(it) }
        override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
            if (Addons.isXpi(request.uri)) { Addons.install(request.uri); return GeckoResult.deny() }
            return null
        }
    }

    private class Progress(val t: Tab) : GeckoSession.ProgressDelegate {
        override fun onProgressChange(session: GeckoSession, progress: Int) { t.progress = progress; ui?.onTabUpdated(t) }
        override fun onPageStart(session: GeckoSession, url: String) { t.progress = 5; ui?.onTabUpdated(t) }
        override fun onPageStop(session: GeckoSession, success: Boolean) { t.progress = 100; ui?.onTabUpdated(t) }
    }

    private class Content(val t: Tab) : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) { t.title = title ?: ""; ui?.onTabUpdated(t) }
        override fun onCloseRequest(session: GeckoSession) { closeTab(t) }
        override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
            val type = response.headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value ?: ""
            if (type.contains("x-xpinstall")) Addons.install(response.uri) else ui?.toast("暂不支持下载文件")
        }
        override fun onCrash(session: GeckoSession) { ui?.toast("页面崩溃了，已重新加载"); session.close(); attachAgain(t) }
        override fun onKill(session: GeckoSession) { attachAgain(t) }
    }

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
    override fun onBeforeUnloadPrompt(session: GeckoSession, prompt: GeckoSession.PromptDelegate.BeforeUnloadPrompt) =
        GeckoResult.fromValue(prompt.confirm(AllowOrDeny.ALLOW))
}
