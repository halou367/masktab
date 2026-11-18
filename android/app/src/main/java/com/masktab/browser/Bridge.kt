package com.masktab.browser

import android.net.Uri
import org.json.JSONObject

// 内置扩展（后台、菜单、节点面板、管理页、新标签页）调用 app 的接口：{m 方法, p 路径, b 内容, inst 哪个实例发的}。
//
// 接口就是核心服务的本地 HTTP 接口，和电脑版同一套（决策 D-4）：这里绝大多数请求原样转给核心服务，回什么就交回什么。
// 只有浏览器归 app 管的那几件事在这里接手：
//   - 界面外壳：/ui/open、/ui/close、/ui/tab、/ui/log
//   - 扩展（Firefox 的扩展由 GeckoView 管）：/api/addons…
//   - 诊断信息：/api/diag；给扩展后台的每实例参数：/ext/state
//   - 打开 / 关闭 / 删除 / 新建实例：核心服务管代理和数据，app 同时要开关标签页、切换显示
// 回复是 JSON 字符串：{"data": …} 或 {"error": "…"}（GeckoView 把回复交回 JS 时不认 JSONObject，JS 那边再 JSON.parse）。
object Bridge {
    /** 安卓版启动步骤（启动页的进度条用）。 */
    val LAUNCH_STEPS = listOf("准备内核", "加载内置扩展", "启动核心服务", "加载订阅", "网络检测")

    fun handle(req: JSONObject, reply: (String) -> Unit) {
        val m = req.str("m", "GET").uppercase()
        val p = req.str("p")
        val uri = Uri.parse("app://x$p")
        val seg = (uri.path ?: "").trim('/').split('/')
        val b = req.optJSONObject("b")
        val ok = { d: Any? -> reply(jsonOf("data" to (d ?: JSONObject.NULL)).toString()) }
        val fail = { e: String -> reply(jsonOf("error" to e).toString()) }
        ui {
            try {
                if (!native(m, seg, b ?: JSONObject(), uri, ok, fail)) forward(m, p, seg, b, req.str("inst"), reply, fail)
            } catch (e: Exception) {
                logw("接口出错 $m $p", e)
                fail(e.message ?: e.toString())
            }
        }
    }

    /** app 自己处理的接口。返回 false = 不归这里管，转给核心服务。 */
    private fun native(m: String, seg: List<String>, b: JSONObject, uri: Uri, ok: (Any?) -> Unit, fail: (String) -> Unit): Boolean {
        val k = "$m /" + seg.joinToString("/")
        val q = { name: String -> uri.getQueryParameter(name) ?: "" }
        when {
            k == "GET /ext/state" -> ok(Core.extState())
            // ---------- 扩展 ----------
            k == "GET /api/addons" -> Addons.list { l -> ok(Addons.toJson(l)) }
            seg.size == 4 && seg[1] == "addons" && m == "POST" -> Addons.act(seg[2], seg[3]) { e -> if (e == null) ok(null) else fail(e) }
            // ---------- 界面 ----------
            // 先回话、再换页面：这几个请求是页面自己发来的，如果在回话之前就把发请求的那个页面（会话）关掉，
            // 等于在它自己的消息回调里销毁它；换页放到下一轮主线程消息里做。
            k == "POST /ui/open" -> { val r = b.str("route"); val full = b.optBoolean("full", true); ok(null); mainHandler.post { Core.ui?.openSheet(r, full) } }
            k == "POST /ui/close" -> { ok(null); mainHandler.post { Core.ui?.closeSheet() } }
            k == "POST /ui/tab" -> { val u = b.str("url").ifEmpty { null }; ok(null); mainHandler.post { Core.ui?.closeSheet(); Host.cur()?.let { Core.openTab(it.id, u) } } }
            k == "POST /ui/restart" -> { ok(null); mainHandler.postDelayed({ Core.restartApp() }, 400) }
            k == "POST /ui/log" -> { Core.pageLog(b.str("msg")); ok(null) }
            // 状态栏、导航栏跟着页面变色（盖了遮罩、底部表单），决策 UI-4
            k == "POST /ui/bars" -> { ok(null); val src = b.str("src"); val dim = b.optBoolean("dim"); val sheet = b.optBoolean("sheet"); mainHandler.post { Core.ui?.pageBars(src, dim, sheet) } }
            // 最近访问（按实例，app 记的；新标签页、历史记录页用）
            k == "GET /ui/recent" -> ok(Recent.list(q("inst").ifEmpty { Host.current }, if (q("all") == "1") 60 else 6))
            k == "POST /ui/recent/clear" -> { Recent.clear(q("inst").ifEmpty { Host.current }); ok(null) }
            // 下载内容（按实例；决策 A-14）：列表、打开 / 分享 / 取消 / 删除 / 重新下载
            k == "GET /ui/downloads" -> ok(Downloads.list(q("inst").ifEmpty { Host.current }))
            k == "POST /ui/downloads/clear" -> { Downloads.clear(q("inst").ifEmpty { Host.current }); ok(null) }
            seg.size == 4 && seg[0] == "ui" && seg[1] == "downloads" && m == "POST" -> {
                val it = Downloads.get(seg[2]) ?: return true.also { fail("这条下载记录已经不在了") }
                val err: String? = when (seg[3]) {
                    "open" -> Downloads.open(Core.app, it)
                    "share" -> Downloads.share(Core.app, it)
                    "cancel" -> { Downloads.cancel(it); null }
                    "remove" -> { Downloads.remove(it, false); null }
                    "delete" -> { Downloads.remove(it, true); null }
                    // 重新下载：在它原来的实例里让内核把这个网址再取一遍（带着这个实例的 Cookie、走它的线路；见 Core.download）
                    "retry" -> {
                        val i = Host.get(it.inst)
                        if (!it.url.startsWith("http")) "这个文件是网页临时生成的，要回到那个网页重新点下载" else if (i == null) "它的实例已经删掉了" else if (!i.running) "实例 #${i.no} 还没启动，先打开它" else {
                            Downloads.remove(it, false)
                            mainHandler.post { Downloads.fromUrl(i, it.url, it.from) }
                            null
                        }
                    }
                    else -> "不认识的操作"
                }
                if (err == null) ok(null) else fail(err)
            }
            // app 发起的下载没成（服务器回了错误、连不上）：内置扩展后台报来的（见 Core.download）
            k == "POST /ui/dl-fail" -> { Core.dlFail(b.str("n"), b.str("err").ifEmpty { "没下成" }.take(120)); ok(null) }
            // 在线更新的最后一步：安装包是核心服务下载、校验的，交给系统安装归 app（Updater.kt，决策 N-3）
            k == "POST /api/update/install" -> Updater.install(ok, fail)
            k == "GET /api/diag" -> bg { val t = try { Core.diag() } catch (e: Exception) { "诊断信息没取全：$e" }; ui { ok(jsonOf("text" to t)) } }
            // ---------- 实例的开关：核心服务管代理，app 管标签页 ----------
            seg.size == 4 && seg[1] == "instances" && m == "POST" && seg[3] == "launch" -> {
                // 打开 / 切换到一个实例：已经在运行就直接切过去；没在运行的先请核心服务启动（选线、探出口），就绪后再切
                Host.get(seg[2]) ?: return true.also { fail("实例不存在") }
                ok(null)
                mainHandler.post { Core.ui?.closeSheet(); Core.switchTo(seg[2]) }
            }
            seg.size == 4 && seg[1] == "instances" && m == "POST" && seg[3] == "stop" -> { Core.stopInst(seg[2]); ok(null) }
            else -> return false
        }
        return true
    }

    /** 转给核心服务。个别请求转完之后 app 还要跟着做点事（见 [after]）。 */
    private fun forward(m: String, p: String, seg: List<String>, b: JSONObject?, inst: String, reply: (String) -> Unit, fail: (String) -> Unit) {
        val who = inst.ifEmpty { Host.current }
        // 删除实例：先把它的标签页和容器数据清掉，再让核心服务删
        if (m == "DELETE" && seg.size == 3 && seg[1] == "instances") Core.dropInst(seg[2])
        bg {
            val slow = m != "GET"
            val r = try {
                CoreProc.call(m, p, if (m == "GET" || m == "DELETE") null else (b ?: JSONObject()).toString(), who, if (slow) 90000 else 15000)
            } catch (e: Exception) {
                logw("接口 $m ${p.substringBefore('?')} 没调通：${e.message}")
                ui { fail("核心服务没有回应：${e.message ?: e.javaClass.simpleName}") }
                return@bg
            }
            if (slow) logi("接口 $m ${p.substringBefore('?')} → ${r.code}")
            if (r.code !in 200..299) {
                val msg = try { JSONObject(r.body).str("error") } catch (e: Exception) { "" }
                ui { fail(msg.ifEmpty { "HTTP ${r.code}" }) }
                return@bg
            }
            if (slow) { Host.refresh(); after(m, seg, b, r.body) }
            var body = r.body.trim().ifEmpty { "null" }
            // 状态里补上只有 app 知道的东西（放在 app 这个键下面）：当前显示的是哪个实例、各实例开着几个标签页
            if (m == "GET" && seg.size == 2 && seg[1] == "state" && body.endsWith("}")) body = body.dropLast(1) + ",\"app\":" + hostInfo() + "}"
            ui { reply("{\"data\":$body}") }
        }
    }

    private fun hostInfo(): String {
        val tabs = JSONObject()
        for ((id, l) in Core.tabs.toMap()) if (l.isNotEmpty()) tabs.put(id, l.size)
        return jsonOf("current" to Host.current, "tabs" to tabs, "ua" to (Host.cur()?.let { Fp.userAgent(it.seed) } ?: "")).toString()
    }

    /** 核心服务办完之后 app 这边接着做的事。在后台线程，状态已经取过新的。 */
    private fun after(m: String, seg: List<String>, b: JSONObject?, body: String) {
        when {
            // 新建实例：核心服务建好就自己启动它，这里等它就绪后切过去（请求里写了 switch:false 的不切）
            m == "POST" && seg.size == 2 && seg[1] == "instances" -> {
                val id = try { JSONObject(body).str("id") } catch (e: Exception) { "" }
                logi("新建实例 #${Host.get(id)?.no ?: "?"}")
                if (id.isNotEmpty() && b?.optBoolean("switch", true) != false) ui { Core.ui?.closeSheet(); Core.openWhenReady(id) }
            }
            // 重启实例（重新选线、探出口）：好了以后把它的标签页刷新一遍
            m == "POST" && seg.size == 4 && seg[1] == "instances" && seg[3] == "restart" -> {
                val id = seg[2]
                Thread.sleep(600)
                Host.waitFor(30000) { Host.get(id)?.let { it.running && !it.starting } ?: true }
                ui { Core.reloadInst(id) }
            }
        }
    }
}
