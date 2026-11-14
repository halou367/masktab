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
            k == "GET /api/state" -> { Core.ensureProxy(); ok(state(uri.getQueryParameter("inst") ?: req.str("inst").ifEmpty { null })) }
            k == "GET /ext/state" -> ok(Core.extState())

            k == "POST /api/instances" -> {
                val i = store.create(b.str("name"))
                Core.restartProxy()
                logi("新建实例 #${i.no}")
                if (b.optBoolean("switch", true)) { Core.switchTo(i.id); Core.ui?.closeSheet() }
                ok(i.toJson())
            }
            k == "POST /api/instances/order" -> { store.reorder(b.optJSONArray("ids")?.strings() ?: emptyList()); Core.pushState(); ok(null) }
            seg.size == 3 && seg[1] == "instances" && m == "PATCH" -> {
                val i = store.get(seg[2]) ?: return fail("实例不存在")
                if (b.has("name")) i.name = b.str("name").trim()
                if (b.has("color")) i.color = b.str("color")
                // 时区、语言先校验：写错的时区名（例如中文“东京”）网页里的伪装会整段失效，露出手机真实时区
                if (b.has("tz")) {
                    val tz = b.str("tz").trim()
                    if (tz.isNotEmpty() && !validTz(tz)) return fail("时区名不对：要写 IANA 名称，例如 Asia/Tokyo、America/New_York；留空 = 跟随出口")
                    i.tz = tz
                }
                if (b.has("lang")) {
                    val lang = b.str("lang").trim()
                    if (lang.isNotEmpty() && !Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$").matches(lang)) return fail("语言写法不对：例如 en-US、ja-JP；留空 = 按出口国家")
                    i.lang = lang
                }
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
                if (i.node != "auto") i.last = ""
                store.save()
                slow(ok, fail) {
                    // 直连 ↔ 代理要改入站，必须重写配置；只是换节点直接切换
                    if (store.subUrl.isNotEmpty() && (wasDirect != i.direct || !Core.mihomo.running)) Core.restartProxyBlocking() else { Core.mihomo.applySelections(store); ui { Core.pushState() } }
                    val rt = store.rtOf(i.id)
                    rt.exit = null; rt.latency = 0
                    if (i.direct) rt.node = ""
                    ui { Core.probe(i.id) }
                    null
                }
            }

            // ---------- 节点与订阅 ----------
            k == "GET /api/nodes" -> slow(ok, fail) { nodes(req.optString("inst").ifEmpty { uri.getQueryParameter("inst") ?: store.current }) }
            // 全部测速：排进后台任务立刻返回，页面轮询 GET /api/nodes 看进度（job）
            k == "POST /api/nodes/test" -> {
                if (store.subUrl.isEmpty()) return fail("还没有订阅")
                if (!Core.job.busy) Core.syncProxy(restart = false, fetch = false, test = true)
                slow(ok, fail) { nodes(req.optString("inst").ifEmpty { uri.getQueryParameter("inst") ?: store.current }) }
            }
            // 刷新订阅：让 mihomo 重新拉一次，再测速
            k == "POST /api/sub/refresh" -> {
                if (store.subUrl.isEmpty()) return fail("还没有订阅")
                if (!Core.job.busy) Core.syncProxy(restart = false, fetch = true, test = true)
                ok(Core.job.toJson())
            }
            k == "PUT /api/sub" -> {
                val url = b.str("url").trim()
                if (url.isNotEmpty() && !Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) return fail("订阅地址要以 http:// 或 https:// 开头")
                val old = store.subUrl
                val had = old.isNotEmpty()
                store.subUrl = url
                // 第一次加订阅：还在直连的实例改为自动选节点（之后用户可逐个改回直连）
                if (!had && url.isNotEmpty()) store.insts.forEach { if (it.direct) it.node = "auto" }
                if (url.isEmpty()) store.insts.forEach { it.node = "DIRECT" }
                if (url != old) store.insts.forEach { it.last = "" }
                store.save()
                store.insts.forEach { val rt = store.rtOf(it.id); rt.exit = null; rt.latency = 0; rt.node = ""; rt.error = "" }
                Core.pushState()
                // 保存后立刻返回；启动 mihomo、拉订阅、测速在后台做，页面轮询 GET /api/nodes 看进度和失败原因
                Core.syncProxy(restart = true, fetch = url.isNotEmpty(), test = if (url.isNotEmpty()) true else null)
                ok(Core.job.toJson())
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
            // 先回话、再换页面：这几个请求是页面自己发来的，如果在回话之前就把发请求的那个页面（会话）关掉，
            // 等于在它自己的消息回调里销毁它；换页放到下一轮主线程消息里做。
            k == "POST /ui/open" -> { val r = b.str("route"); val full = b.optBoolean("full", true); ok(null); mainHandler.post { Core.ui?.openSheet(r, full) } }
            k == "POST /ui/close" -> { ok(null); mainHandler.post { Core.ui?.closeSheet() } }
            k == "POST /ui/tab" -> { val u = b.str("url").ifEmpty { null }; ok(null); mainHandler.post { Core.ui?.closeSheet(); Core.openTab(store.current, u) } }
            k == "POST /ui/log" -> { Core.pageLog(b.str("msg")); ok(null) }
            k == "GET /api/diag" -> slow(ok, fail) { jsonOf("text" to Core.diag()) }
            else -> fail("未知接口 $k")
        }
    }

    private fun validTz(tz: String): Boolean = tz.contains('/') && try { java.time.ZoneId.of(tz); true } catch (e: Exception) { false }

    private fun emailOf(i: Inst): String = if (i.name.contains("@") && !i.name.any { it == ' ' || it == '\t' }) i.name else ""

    fun nodes(instId: String): JSONObject {
        val i = store.get(instId)
        val mh = Core.mihomo
        val running = mh.running
        val info = if (running) mh.providerInfo() else null
        val job = Core.job
        return jsonOf(
            "sub" to jsonOf("url" to store.subUrl, "running" to running, "version" to mh.version, "error" to job.error.ifEmpty { mh.lastError },
                "updatedAt" to (info?.str("updatedAt") ?: ""), "loaded" to (info != null)),
            "nodes" to JSONArray(if (running) mh.nodes().map { it.toJson() } else emptyList()),
            "inst" to (i?.let { jsonOf("id" to it.id, "node" to it.node, "now" to (if (it.direct || !running) "" else mh.selected(it).takeUnless { n -> n == "REJECT" } ?: "")) } ?: JSONObject.NULL),
            "job" to job.toJson(),
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
        vault.batch {
            for ((email, own) in pairs) {
                if (email in exist) { skipped++; continue }
                val pass = own.ifEmpty { def }
                val i = store.create(email)
                created++
                if (pass.isEmpty()) noPass++
                vault.upsert(VItem(inst = i.id, site = "*", user = email, pass = pass, src = "import"))
            }
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
            "proxy" to jsonOf("running" to Core.mihomo.running, "error" to Core.job.error.ifEmpty { Core.mihomo.lastError }, "installed" to Core.mihomo.installed, "busy" to Core.job.busy),
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
