package com.masktab.browser

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

// 内置扩展（后台、菜单、管理页、新标签页）调用 app 的接口。
// 形式模仿桌面核心服务的本地 HTTP 接口（方法 + 路径 + JSON），这样桌面的 menu.js / instances.js 可以原样复用，
// 只把 api.js 换成走 GeckoView 原生消息（runtime.sendNativeMessage）的版本。
// 回复：{data: …} 或 {error: "…"}。

object Bridge {
    /** 安卓版启动步骤（启动页与实例菜单的进度条用）。 */
    val LAUNCH_STEPS = listOf("准备内核", "加载内置扩展", "启动 mihomo", "加载订阅", "网络检测")

    private val store get() = Core.store
    private val vault get() = Core.vault

    fun handle(req: JSONObject, reply: (JSONObject) -> Unit) {
        val m = req.str("m", "GET").uppercase()
        val uri = Uri.parse("app://x" + req.str("p"))
        val path = uri.path ?: ""
        val b = req.optJSONObject("b") ?: JSONObject()
        val seg = path.trim('/').split('/')
        val ok = { d: Any? -> reply(jsonOf("data" to (d ?: JSONObject.NULL))) }
        val fail = { e: String -> reply(jsonOf("error" to e)) }
        ui {
            try {
                route(m, seg, uri, b, req, ok, fail)
            } catch (e: Exception) {
                logw("接口出错 $m $path", e)
                fail(e.message ?: e.toString())
            }
        }
    }

    private fun slow(ok: (Any?) -> Unit, fail: (String) -> Unit, block: () -> Any?) {
        bg {
            try { val r = block(); ui { ok(r) } } catch (e: Exception) { ui { fail(e.message ?: e.toString()) } }
        }
    }

    private fun route(m: String, seg: List<String>, uri: Uri, b: JSONObject, req: JSONObject, ok: (Any?) -> Unit, fail: (String) -> Unit) {
        val k = "$m /" + seg.joinToString("/")
        when {
            k == "GET /api/state" -> ok(state(uri.getQueryParameter("inst")))
            k == "GET /ext/state" -> ok(Core.extState())

            k == "POST /api/instances" -> {
                val i = store.create(b.str("name"))
                Core.restartProxy()
                if (b.optBoolean("switch", true)) { Core.switchTo(i.id); Core.ui?.closeSheet() }
                ok(i.toJson())
            }
            k == "POST /api/instances/order" -> { store.reorder(b.optJSONArray("ids")?.strings() ?: emptyList()); Core.pushState(); ok(null) }
            seg.size == 3 && seg[1] == "instances" && m == "PATCH" -> {
                val i = store.get(seg[2]) ?: return fail("实例不存在")
                if (b.has("name")) i.name = b.str("name").trim()
                if (b.has("color")) i.color = b.str("color")
                if (b.has("tz")) i.tz = b.str("tz").trim()
                if (b.has("lang")) i.lang = b.str("lang").trim()
                store.save()
                Core.pushState()
                Core.ui?.onTabsChanged()
                ok(i.toJson())
            }
            seg.size == 3 && seg[1] == "instances" && m == "DELETE" -> { Core.deleteInst(seg[2]); ok(null) }
            seg.size == 4 && seg[1] == "instances" && m == "POST" -> {
                val id = seg[2]
                store.get(id) ?: return fail("实例不存在")
                when (seg[3]) {
                    "launch" -> { Core.switchTo(id); Core.ui?.closeSheet() }
                    "stop" -> Core.stopInst(id)
                    "restart" -> Core.reloadInst(id)
                    "probe" -> Core.probe(id)
                    "reseed" -> { store.get(id)!!.seed = randomLong(); store.save(); Core.refreshIdentity(id) }
                    else -> return fail("未知操作")
                }
                ok(null)
            }
            seg.size == 4 && seg[1] == "instances" && seg[3] == "node" && m == "PUT" -> {
                val i = store.get(seg[2]) ?: return fail("实例不存在")
                val wasDirect = i.direct
                i.node = b.str("node", "auto")
                store.save()
                Core.pushState()
                slow(ok, fail) {
                    // 直连 ↔ 代理要改入站，必须重写配置；只是换节点直接切换
                    if (wasDirect != i.direct || !Core.mihomo.running) Core.restartProxyBlocking() else { Core.mihomo.applySelections(store); ui { Core.pushState() } }
                    store.rtOf(i.id).exit = null
                    ui { Core.probe(i.id) }
                    null
                }
            }

            // ---------- 节点与订阅 ----------
            k == "GET /api/nodes" -> slow(ok, fail) { nodes(req.optString("inst").ifEmpty { uri.getQueryParameter("inst") ?: store.current }) }
            k == "POST /api/nodes/test" -> slow(ok, fail) { Core.mihomo.healthcheck(); nodes(uri.getQueryParameter("inst") ?: store.current) }
            k == "PUT /api/sub" -> {
                val url = b.str("url").trim()
                if (url.isNotEmpty() && !Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) return fail("订阅地址要以 http:// 或 https:// 开头")
                val had = store.subUrl.isNotEmpty()
                store.subUrl = url
                // 第一次加订阅：还在直连的实例改为自动选节点（之后用户可逐个改回直连）
                if (!had && url.isNotEmpty()) store.insts.forEach { if (it.direct) it.node = "auto" }
                if (url.isEmpty()) store.insts.forEach { it.node = "DIRECT" }
                store.save()
                slow(ok, fail) {
                    val good = Core.restartProxyBlocking()
                    if (good && url.isNotEmpty()) { waitProvider(15000); Core.mihomo.applySelections(store); ui { Core.pushState() } }
                    store.insts.forEach { store.rtOf(it.id).exit = null }
                    ui { Core.probe(store.current) }
                    if (!good) throw IllegalStateException(Core.mihomo.lastError)
                    null
                }
            }
            k == "PUT /api/settings" -> {
                if (b.has("searchUrl")) store.searchUrl = b.str("searchUrl").ifEmpty { store.searchUrl }
                store.save(); Core.pushState(); ok(null)
            }

            // ---------- 密码库 ----------
            k == "GET /api/vault" -> ok(jsonOf("items" to JSONArray(vault.list(uri.getQueryParameter("inst") ?: "").map { it.toJson() }), "hasDefault" to vault.default().isNotEmpty()))
            k == "GET /api/vault/match" -> {
                val inst = req.str("inst")
                val i = store.get(inst) ?: return fail("实例不存在")
                val nos = store.insts.associate { it.id to it.no }
                val items = vault.match(inst, uri.getQueryParameter("site") ?: "").map { it.toJson().put("no", nos[it.inst] ?: 0).put("mine", it.inst == inst) }
                ok(jsonOf("items" to JSONArray(items), "default" to vault.default(), "email" to emailOf(i), "no" to i.no))
            }
            k == "POST /api/vault" -> {
                val it = VItem.from(b)
                if (it.inst.isEmpty()) it.inst = req.str("inst")
                store.get(it.inst) ?: return fail("实例不存在")
                val saved = vault.upsert(it)
                Core.ui?.onTabsChanged()
                ok(saved.toJson())
            }
            seg.size == 3 && seg[1] == "vault" && m == "DELETE" -> { vault.delete(seg[2]); ok(null) }
            k == "PUT /api/vault/default" -> { vault.setDefault(b.str("password")); ok(null) }
            k == "POST /api/import/emails" -> ok(importEmails(b.str("text"), b.str("password"), b.optBoolean("save")))
            k == "POST /api/cookies" -> {
                val rt = store.rtOf(req.str("inst").ifEmpty { b.str("inst") })
                val list = (b.optJSONArray("domains") ?: JSONArray()).objects().sortedByDescending { it.optInt("n") }
                rt.cookies = JSONArray(list.take(40))
                rt.cookieN = list.sumOf { it.optInt("n") }
                ok(null)
            }

            // ---------- 扩展 ----------
            k == "GET /api/addons" -> Addons.list { l -> ok(Addons.toJson(l)) }
            seg.size == 4 && seg[1] == "addons" && m == "POST" -> Addons.act(seg[2], seg[3]) { e -> if (e == null) ok(null) else fail(e) }

            // ---------- 界面 ----------
            k == "POST /ui/open" -> { Core.ui?.openSheet(b.str("route"), b.optBoolean("full", true)); ok(null) }
            k == "POST /ui/close" -> { Core.ui?.closeSheet(); ok(null) }
            k == "POST /ui/tab" -> { Core.openTab(store.current, b.str("url").ifEmpty { null }); Core.ui?.closeSheet(); ok(null) }
            else -> fail("未知接口 $k")
        }
    }

    private fun emailOf(i: Inst): String = if (i.name.contains("@") && !i.name.any { it == ' ' || it == '\t' }) i.name else ""

    private fun waitProvider(ms: Long) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (Core.mihomo.nodes().isNotEmpty()) return
            Thread.sleep(500)
        }
    }

    fun nodes(instId: String): JSONObject {
        val i = store.get(instId)
        val mh = Core.mihomo
        val info = if (mh.running) mh.providerInfo() else null
        return jsonOf(
            "sub" to jsonOf("url" to store.subUrl, "running" to mh.running, "version" to mh.version, "error" to mh.lastError,
                "updatedAt" to (info?.str("updatedAt") ?: ""), "loaded" to (info != null)),
            "nodes" to JSONArray(if (mh.running) mh.nodes().map { it.toJson() } else emptyList()),
            "inst" to (i?.let { jsonOf("id" to it.id, "node" to it.node, "now" to (if (it.direct || !mh.running) "" else mh.selected(it))) } ?: JSONObject.NULL),
        )
    }

    private fun importEmails(text: String, password: String, save: Boolean): JSONObject {
        val (pairs, bad) = Vault.parseEmails(text)
        var def = password
        if (def.isEmpty()) def = vault.default() else if (save || vault.default().isEmpty()) vault.setDefault(def)
        val exist = store.insts.mapNotNull { emailOf(it).ifEmpty { null }?.lowercase() }.toSet()
        var created = 0
        var skipped = 0
        var noPass = 0
        for ((email, own) in pairs) {
            if (email in exist) { skipped++; continue }
            val pass = own.ifEmpty { def }
            val i = store.create(email)
            created++
            if (pass.isEmpty()) noPass++
            vault.upsert(VItem(inst = i.id, site = "*", user = email, pass = pass, src = "import"))
        }
        Core.restartProxy()
        Core.ui?.onTabsChanged()
        return jsonOf("created" to created, "skipped" to skipped, "bad" to bad.size, "noPass" to noPass)
    }

    /** 与桌面 /api/state 同形状的状态（menu.js、instances.js 直接用）。 */
    fun state(meId: String?): JSONObject {
        val sites = vault.sites()
        val counts = vault.count()
        val arr = JSONArray()
        var me: JSONObject? = null
        for (i in store.sorted()) {
            val v = instView(i, sites[i.id] ?: emptyList(), counts[i.id] ?: 0)
            arr.put(v)
            if (i.id == (meId ?: store.current)) me = v
        }
        return jsonOf(
            "me" to (me ?: arr.optJSONObject(0)), "instances" to arr, "palette" to JSONArray(PALETTE),
            "launchSteps" to JSONArray(LAUNCH_STEPS),
            "vault" to jsonOf("hasDefault" to vault.default().isNotEmpty(), "error" to vault.error.ifEmpty { null }),
            "settings" to jsonOf("searchUrl" to store.searchUrl, "subUrl" to store.subUrl),
            "proxy" to jsonOf("running" to Core.mihomo.running, "error" to Core.mihomo.lastError, "installed" to Core.mihomo.installed),
            "current" to store.current, "platform" to "android",
        )
    }

    private fun instView(i: Inst, sites: List<String>, count: Int): JSONObject {
        val rt = store.rtOf(i.id)
        val ex = rt.exit?.toJson()
        val tabs = Core.tabsOf(i.id)
        return jsonOf(
            "id" to i.id, "no" to i.no, "name" to i.name, "color" to i.color, "kind" to "persistent", "node" to i.node,
            "seed" to i.seed, "tzSet" to i.tz, "langSet" to i.lang, "ua" to Fp.userAgent(i.seed),
            "tz" to jsonOf("source" to "exit-cf", "effective" to Fp.tzFor(i, rt.exit), "lang" to Fp.langFor(i, rt.exit)),
            "proxy" to jsonOf("state" to if (i.direct) "off" else "on"),
            "rt" to jsonOf(
                "running" to tabs.isNotEmpty(), "starting" to false, "tabs" to tabs.size, "current" to (i.id == store.current),
                "latency" to rt.latency, "probing" to rt.probing, "error" to rt.error.ifEmpty { null },
                "probe" to (ex?.let { jsonOf("cf" to it, "direct" to it) } ?: JSONObject.NULL),
                "launchedTz" to Fp.tzFor(i, rt.exit).ifEmpty { null }, "needRestart" to JSONArray(),
            ),
            "acct" to jsonOf("sites" to JSONArray(sites), "count" to count, "cookies" to rt.cookies, "cookieN" to rt.cookieN),
        )
    }
}
