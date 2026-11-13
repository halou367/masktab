package com.masktab.browser

import org.json.JSONArray
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebExtensionController

// 用户扩展：从 addons.mozilla.org 安装（点“添加到 Firefox”时拦下 .xpi 交给 GeckoView 安装，安装前弹确认），
// 启用 / 停用 / 移除，点扩展的工具栏按钮弹出它的弹窗。只认 AMO 签过名的扩展（GeckoView 正式版强制签名）。

object Addons {
    fun isXpi(uri: String): Boolean {
        val u = uri.substringBefore('?').lowercase()
        return u.endsWith(".xpi") || (u.contains("addons.mozilla.org/") && u.contains("/downloads/file/"))
    }

    fun install(uri: String) {
        val c = Core.runtime?.webExtensionController ?: return
        Core.ui?.toast("正在下载扩展…")
        c.install(uri, WebExtensionController.INSTALLATION_METHOD_MANAGER).accept({ e ->
            if (e != null) { watch(e); Core.ui?.toast("已安装：${e.metaData.name ?: e.id}") }
        }, { err ->
            val code = (err as? WebExtension.InstallException)?.code
            if (code != WebExtension.InstallException.ErrorCodes.ERROR_USER_CANCELED) Core.ui?.toast("安装失败：" + (err?.message ?: "代码 $code"))
        })
    }

    /** 记下扩展的工具栏按钮，弹窗交给界面显示。 */
    fun watch(e: WebExtension) {
        if (e.isBuiltIn) return
        e.setActionDelegate(object : WebExtension.ActionDelegate {
            override fun onBrowserAction(extension: WebExtension, session: GeckoSession?, action: WebExtension.Action) { Core.actions[extension.id] = action }
            override fun onPageAction(extension: WebExtension, session: GeckoSession?, action: WebExtension.Action) { Core.actions.putIfAbsent(extension.id, action) }
            override fun onOpenPopup(extension: WebExtension, action: WebExtension.Action): GeckoResult<GeckoSession>? = popup()
            override fun onTogglePopup(extension: WebExtension, action: WebExtension.Action): GeckoResult<GeckoSession>? = popup()
        })
    }

    private fun popup(): GeckoResult<GeckoSession> {
        val s = GeckoSession()
        Core.ui?.showPopup(s)
        return GeckoResult.fromValue(s)
    }

    /** 列出用户扩展（不含内置扩展）。回调在主线程。 */
    fun list(done: (List<WebExtension>) -> Unit) {
        val c = Core.runtime?.webExtensionController ?: return done(emptyList())
        c.list().accept({ l -> val u = (l ?: emptyList()).filter { !it.isBuiltIn }; u.forEach { watch(it) }; done(u) }, { done(emptyList()) })
    }

    fun toJson(l: List<WebExtension>) = JSONArray(l.map { e ->
        jsonOf(
            "id" to e.id, "name" to (e.metaData.name ?: e.id), "version" to e.metaData.version, "enabled" to e.metaData.enabled,
            "desc" to (e.metaData.description ?: ""), "action" to Core.actions.containsKey(e.id),
            "options" to (e.metaData.optionsPageUrl != null), "amo" to (e.metaData.amoListingUrl ?: ""),
        )
    })

    fun act(id: String, op: String, done: (String?) -> Unit) {
        val c = Core.runtime?.webExtensionController ?: return done("内核未就绪")
        list { l ->
            val e = l.firstOrNull { it.id == id } ?: return@list done("扩展不存在")
            val r: GeckoResult<*> = when (op) {
                "enable" -> c.enable(e, WebExtensionController.EnableSource.USER)
                "disable" -> c.disable(e, WebExtensionController.EnableSource.USER)
                "remove" -> c.uninstall(e)
                "action" -> { val a = Core.actions[id] ?: return@list done("这个扩展没有工具栏按钮"); a.click(); GeckoResult.fromValue(null) }
                "options" -> { e.metaData.optionsPageUrl?.let { Core.openTab(Core.store.current, it, raw = true) }; GeckoResult.fromValue(null) }
                else -> return@list done("未知操作")
            }
            r.accept({ if (op == "remove") Core.actions.remove(id); done(null) }, { err -> done(err?.message ?: "失败") })
        }
    }
}
