package com.masktab.browser

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView

// 唯一的 Activity：像手机 Chrome——顶部地址栏，右侧依次是标签数、头像（当前实例的彩色编号圆点）、菜单。
// 点头像弹出实例菜单（内置扩展页面 app.html#menu，复用桌面 menu.js）。

class MainActivity : Activity(), CoreUi {
    private lateinit var gecko: GeckoView
    private lateinit var url: EditText
    private lateinit var tabCount: TabCountView
    private lateinit var avatar: AvatarView
    private lateinit var progress: ProgressBar
    private var startup: StartupView? = null
    private var sheet: Dialog? = null
    private var sheetSession: GeckoSession? = null
    private var sheetRoute = ""
    private var sheetFull = false
    private var sheetRetry = 0
    private var shown: GeckoSession? = null
    private var hold = false
    override var prompts: Prompts? = null

    private val bar = Color.parseColor("#F1F3F4")
    private val ink = Color.parseColor("#3C4043")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Core.init(this)
        Core.ui = this
        prompts = Prompts(this)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        hold = intent?.getBooleanExtra("mt_hold", false) == true
        setContentView(buildUi())
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
        if (!Core.started) boot() else { onTabsChanged(); handleIntent(intent) }
    }

    override fun onDestroy() {
        if (Core.ui === this) Core.ui = null
        sheet?.dismiss()
        gecko.releaseSession()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 测试用的启动参数（CI 截图）：mt_open=menu|instances|…打开对应页面；mt_inst=<实例id> 切换实例；mt_hold 让启动页停留。外部链接（VIEW）在当前实例打开。 */
    private fun handleIntent(i: Intent?) {
        if (i == null || !Core.started) return
        if (i.action == Intent.ACTION_VIEW && i.data != null) { closeSheet(); Core.openTab(Core.store.current, i.dataString); return }
        if (i.getBooleanExtra("mt_hold", false)) return
        if (hold) { hold = false; hideStartup() }
        i.getStringExtra("mt_inst")?.let { id -> closeSheet(); Core.switchTo(id) }
        i.getStringExtra("mt_open")?.let { r -> openSheet(r, r != "menu") }
        i.removeExtra("mt_open")
        i.removeExtra("mt_inst")
    }

    // ---------- 界面 ----------

    private fun iconBtn(v: View, desc: String, onClick: () -> Unit): View {
        v.contentDescription = desc
        v.setOnClickListener { onClick() }
        v.background = obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackgroundBorderless)).let { a -> a.getDrawable(0).also { a.recycle() } }
        return v
    }

    private fun buildUi(): View {
        val root = FrameLayout(this)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
        val tb = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(6), dp(4), dp(6))
            setBackgroundColor(Color.WHITE)
        }
        url = EditText(this).apply {
            hint = "搜索或输入网址"
            setSingleLine()
            textSize = 15f
            setTextColor(Color.parseColor("#202124"))
            setHintTextColor(Color.parseColor("#80868B"))
            background = rounded(bar, dp(24).toFloat())
            setPadding(dp(16), 0, dp(12), 0)
            imeOptions = EditorInfo.IME_ACTION_GO
            inputType = EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_VARIATION_URI
            ellipsize = TextUtils.TruncateAt.END
            setSelectAllOnFocus(true)
            setOnEditorActionListener { _, a, ev ->
                if (a == EditorInfo.IME_ACTION_GO || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { go(text.toString()); true } else false
            }
            setOnFocusChangeListener { _, f -> if (f) { Core.curTab()?.let { t -> setText(if (Core.isInternal(t.url)) "" else t.url); selectAll() } } else showUrl() }
        }
        tb.addView(url, LinearLayout.LayoutParams(0, dp(44), 1f))
        tabCount = TabCountView(this).apply { tint = ink }
        tb.addView(iconBtn(tabCount, "标签页") { showTabs() }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { leftMargin = dp(4) })
        avatar = AvatarView(this)
        tb.addView(iconBtn(avatar, "实例") { openSheet("menu", false) }, LinearLayout.LayoutParams(dp(44), dp(44)))
        val dots = DotsView(this).apply { tint = ink }
        tb.addView(iconBtn(dots, "菜单") { showMenu(dots) }, LinearLayout.LayoutParams(dp(40), dp(44)))
        col.addView(tb, LinearLayout.LayoutParams(-1, -2))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.INVISIBLE }
        col.addView(progress, LinearLayout.LayoutParams(-1, dp(3)))
        gecko = GeckoView(this)
        col.addView(gecko, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(col, FrameLayout.LayoutParams(-1, -1))
        fitInsets(col)
        if (!Core.started) {
            startup = StartupView(this, Bridge.LAUNCH_STEPS)
            root.addView(startup, FrameLayout.LayoutParams(-1, -1))
        }
        return root
    }

    /** 安卓 15+ 强制全屏绘制：给内容留出状态栏、导航栏和输入法的位置。 */
    private fun fitInsets(v: View) {
        v.setOnApplyWindowInsetsListener { view, ins ->
            if (Build.VERSION.SDK_INT >= 30) {
                val b = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(b.left, b.top, b.right, b.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(ins.systemWindowInsetLeft, ins.systemWindowInsetTop, ins.systemWindowInsetRight, ins.systemWindowInsetBottom)
            }
            ins
        }
    }

    private fun showUrl() {
        val t = Core.curTab()
        if (url.hasFocus()) return
        val u = t?.url ?: ""
        url.setText(if (Core.isInternal(u) || u.isEmpty()) "" else u.removePrefix("https://").removePrefix("http://").removeSuffix("/"))
    }

    private fun go(input: String) {
        val q = input.trim()
        if (q.isEmpty()) return
        val isUrl = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(q) || (Regex("^[^\\s]+\\.[^\\s]{2,}$").matches(q))
        val target = if (isUrl) (if (q.contains("://")) q else "https://$q") else Core.store.searchUrl.replace("%s", java.net.URLEncoder.encode(q, "UTF-8"))
        val t = Core.curTab()
        if (t == null) Core.openTab(Core.store.current, target) else t.session.loadUri(target)
        url.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(url.windowToken, 0)
        gecko.requestFocus()
    }

    override fun onTabsChanged() {
        val i = Core.store.cur()
        val t = Core.curTab()
        if (t != null && shown !== t.session) {
            gecko.releaseSession()
            for ((_, l) in Core.tabs) for (x in l) if (x !== t) x.session.setActive(false)
            gecko.setSession(t.session)
            t.session.setActive(true)
            shown = t.session
        }
        tabCount.count = Core.tabsOf(i.id).size
        avatar.set(parseColor(i.color), i.no.toString(), flagBitmap(this, Core.store.rtOf(i.id).exit?.country.takeUnless { i.direct }))
        avatar.contentDescription = "实例 #${i.no} ${i.name}"
        t?.let { onTabUpdated(it) }
    }

    override fun onTabUpdated(t: Tab) {
        if (t !== Core.curTab()) return
        showUrl()
        progress.progress = t.progress
        progress.visibility = if (t.progress in 1..99) View.VISIBLE else View.INVISIBLE
    }

    override fun toast(msg: String) = ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    // ---------- 启动 ----------

    private fun boot() {
        val st = startup!!
        val t0 = System.currentTimeMillis()
        fun step(k: Int, s: Int, d: String = "") { logi("启动步骤 ${k + 1} ${Bridge.LAUNCH_STEPS[k]}：$s $d"); ui { st.set(k, s, d) } }
        // 每步至少显示一会儿，免得一闪而过
        fun pace(since: Long) { val left = 450 - (System.currentTimeMillis() - since); if (left > 0) Thread.sleep(left) }
        step(0, 1)
        try { Core.ensureRuntime() } catch (e: Throwable) { step(0, 4, e.message ?: "内核启动失败"); return }
        step(0, 2, "GeckoView " + (GeckoSession.getDefaultUserAgent().substringAfter("rv:").substringBefore(")")))
        step(1, 1)
        Core.ensureExt { err ->
            if (err != null) { step(1, 4, err); return@ensureExt }
            step(1, 2)
            bg {
                var s = System.currentTimeMillis()
                pace(t0)
                val store = Core.store
                // mihomo
                if (store.subUrl.isEmpty()) {
                    step(2, 3, "还没有订阅，全部实例直连"); step(3, 3, "在“节点与出口”里填订阅地址")
                } else {
                    step(2, 1)
                    val ok = Core.mihomo.start(store)
                    pace(s)
                    step(2, if (ok) 2 else 4, if (ok) "mihomo ${Core.mihomo.version}" else Core.mihomo.lastError)
                    s = System.currentTimeMillis()
                    step(3, 1)
                    if (ok) {
                        // 等节点、选节点；“自动”实例手上的节点不通时在这里把全部节点测一遍（进度显示在这一步），再挑一个通的
                        Core.job.busy = true
                        val n = try { Core.loadSub(fetch = false, test = null) { msg -> step(3, 1, msg) } } catch (e: Exception) { logw("加载订阅出错", e); 0 } finally { Core.job.busy = false; Core.job.phase = "" }
                        pace(s)
                        val good = Core.mihomo.nodes().count { it.good }
                        step(3, if (n > 0) 2 else 4, if (n > 0) "$n 个节点" + (if (good > 0) "，测过可用 $good 个" else "") else Core.job.error.ifEmpty { "订阅没有拉到节点" })
                    } else { Core.job.error = Core.mihomo.lastError; step(3, 3) }
                }
                // 网络检测：当前实例的出口
                s = System.currentTimeMillis()
                step(4, 1)
                val i = store.cur()
                val (ex, ms) = Probe.exit(i, Core.mihomo.running)
                val rt = store.rtOf(i.id)
                if (ex != null) { rt.exit = ex; rt.latency = ms }
                pace(s)
                step(4, if (ex != null) 2 else 4, if (ex != null) "#${i.no} 出口 ${ex.country} · ${ex.ip}" + (if (i.direct) "（直连）" else "") else "连不上外网")
                Thread.sleep(500)
                ui {
                    logi("启动完成，用时 ${System.currentTimeMillis() - t0} 毫秒")
                    Core.started = true
                    Core.pushState()
                    Core.restoreTabs()
                    if (!hold) hideStartup()
                    handleIntent(intent)
                }
            }
        }
    }

    private fun hideStartup() {
        val v = startup ?: return
        startup = null
        v.animate().alpha(0f).setDuration(250).withEndAction { (v.parent as? ViewGroup)?.removeView(v) }.start()
    }

    // ---------- 实例菜单、管理页等（内置扩展页面） ----------

    override fun openSheet(route: String, full: Boolean) { sheetRetry = 0; showSheet(route, full) }

    private fun showSheet(route: String, full: Boolean) {
        if (!Core.started || Core.baseUrl.isEmpty() || isFinishing || isDestroyed) return
        // 已经开着一个整页：在同一个页面里换路由（地址 # 后面变了，页面自己重画），不销毁重建窗口和会话
        val cur = sheetSession
        if (full && sheetFull && sheet?.isShowing == true && cur != null && cur.isOpen) {
            sheetRoute = route
            cur.loadUri(Core.pageUrl(route))
            return
        }
        closeSheet()
        val d = Dialog(this, if (full) android.R.style.Theme_Material_Light_NoActionBar else android.R.style.Theme_Material_Light_Dialog_NoActionBar)
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val v = GeckoView(this)
        val s = GeckoSession()
        s.promptDelegate = PromptBridge
        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
                // 菜单 / 管理页里点到的外部链接在当前实例的新标签页打开
                if (request.uri.startsWith("http")) { val u = request.uri; mainHandler.post { closeSheet(); Core.openTab(Core.store.current, u) }; return GeckoResult.deny() }
                return null
            }
            override fun onLoadError(session: GeckoSession, uri: String?, error: org.mozilla.geckoview.WebRequestError): GeckoResult<String>? {
                logw("内置页面打不开 $uri 类别 ${error.category} 代码 ${error.code}")
                Core.pageLog("内置页面打不开 ${uri?.substringAfterLast('/')} 代码 ${error.code}")
                return null
            }
        }
        s.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onCloseRequest(session: GeckoSession) { if (sheetSession === session) closeSheet() }
            // 扩展页面所在的进程崩溃或被系统回收（手机内存紧张时常见）：页面会变成一片白，这里关掉重开，最多两次
            override fun onCrash(session: GeckoSession) { sheetDied(session, "崩溃") }
            override fun onKill(session: GeckoSession) { sheetDied(session, "被系统回收") }
        }
        s.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStop(session: GeckoSession, success: Boolean) { if (!success) logw("内置页面加载失败 $sheetRoute") }
        }
        Core.ext?.let { s.webExtensionController.setMessageDelegate(it, Core.sessionMsg(null), Core.NATIVE) }
        s.open(Core.ensureRuntime())
        v.setSession(s)
        s.loadUri(Core.pageUrl(route))
        val box = FrameLayout(this)
        box.addView(v, FrameLayout.LayoutParams(-1, -1))
        if (full) fitInsets(box)
        d.setContentView(box)
        d.window?.let { w ->
            if (full) {
                w.setLayout(-1, -1)
            } else {
                w.setBackgroundDrawable(rounded(Color.WHITE, dp(20).toFloat()))
                w.setGravity(Gravity.TOP or Gravity.END)
                val lp = w.attributes
                lp.width = minOf(resources.displayMetrics.widthPixels - dp(16), dp(380))
                lp.height = (resources.displayMetrics.heightPixels * 0.78f).toInt()
                lp.y = dp(56)
                lp.x = dp(8)
                lp.dimAmount = 0.25f
                w.attributes = lp
                w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            }
        }
        d.setOnDismissListener {
            if (sheet === d) { sheet = null; sheetSession = null; sheetFull = false }
            try { v.releaseSession(); s.close() } catch (e: Exception) { logw("关闭内置页面出错", e) }
            onTabsChanged()
        }
        sheet = d
        sheetSession = s
        sheetRoute = route
        sheetFull = full
        try { d.show() } catch (e: Exception) { logw("页面窗口打不开", e); sheet = null; sheetSession = null; s.close() }
    }

    private fun sheetDied(session: GeckoSession, why: String) {
        if (sheetSession !== session) return
        logw("内置页面$why：$sheetRoute（第 ${sheetRetry + 1} 次）")
        Core.pageLog("内置页面$why：$sheetRoute")
        val r = sheetRoute
        val f = sheetFull
        closeSheet()
        if (sheetRetry++ < 2) mainHandler.postDelayed({ showSheet(r, f) }, 400) else toast("页面打不开（内置扩展进程$why），请重启应用")
    }

    override fun closeSheet() {
        val d = sheet ?: return
        sheet = null
        sheetSession = null
        sheetFull = false
        try { d.dismiss() } catch (e: Exception) { logw("关闭页面窗口出错", e) }
    }

    /** 用户扩展的弹窗。 */
    override fun showPopup(session: GeckoSession) {
        val d = Dialog(this, android.R.style.Theme_Material_Light_Dialog_NoActionBar)
        val v = GeckoView(this)
        mainHandler.post { if (!session.isOpen) session.open(Core.ensureRuntime()); v.setSession(session) }
        d.setContentView(v, ViewGroup.LayoutParams(-1, -1))
        d.window?.setLayout(-1, (resources.displayMetrics.heightPixels * 0.7f).toInt())
        session.contentDelegate = object : GeckoSession.ContentDelegate { override fun onCloseRequest(s: GeckoSession) { d.dismiss() } }
        d.setOnDismissListener { v.releaseSession(); session.close() }
        d.show()
    }

    // ---------- 标签页列表 ----------

    private fun showTabs() {
        val i = Core.store.cur()
        val d = Dialog(this, android.R.style.Theme_Material_Light_NoActionBar)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.parseColor("#F8F9FA")) }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), dp(10), dp(8), dp(10)) }
        head.addView(AvatarView(this).apply { set(parseColor(i.color), i.no.toString(), null) }, LinearLayout.LayoutParams(dp(36), dp(36)))
        head.addView(TextView(this).apply {
            text = "#${i.no}  ${i.name.ifEmpty { "实例" }}"; textSize = 16f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.parseColor("#202124"))
            setPadding(dp(10), 0, 0, 0); ellipsize = TextUtils.TruncateAt.END; setSingleLine()
        }, LinearLayout.LayoutParams(0, -2, 1f))
        head.addView(iconBtn(TextView(this).apply { text = "＋"; textSize = 24f; gravity = Gravity.CENTER; setTextColor(ink) }, "新标签页") {
            d.dismiss(); Core.openTab(i.id)
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        col.addView(head)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(12), dp(12)) }
        fun fill() {
            list.removeAllViews()
            for (t in Core.tabsOf(i.id)) {
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(14), dp(10), dp(4), dp(10))
                    background = rounded(Color.WHITE, dp(14).toFloat(), if (t === Core.active[i.id]) dp(2) else dp(1), if (t === Core.active[i.id]) parseColor(i.color) else Color.parseColor("#E0E3E7"))
                    setOnClickListener { Core.selectTab(t); d.dismiss() }
                }
                val tx = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                val internal = Core.isInternal(t.url) || t.url.isEmpty()
                tx.addView(TextView(this).apply { text = if (internal) "新标签页" else t.title.ifEmpty { t.url }; textSize = 14f; setTextColor(Color.parseColor("#202124")); setSingleLine(); ellipsize = TextUtils.TruncateAt.END })
                if (!internal) tx.addView(TextView(this).apply { text = t.url; textSize = 12f; setTextColor(Color.parseColor("#5F6368")); setSingleLine(); ellipsize = TextUtils.TruncateAt.MIDDLE })
                row.addView(tx, LinearLayout.LayoutParams(0, -2, 1f))
                row.addView(iconBtn(TextView(this).apply { text = "✕"; textSize = 16f; gravity = Gravity.CENTER; setTextColor(Color.parseColor("#5F6368")) }, "关闭标签") {
                    Core.closeTab(t); if (Core.tabsOf(i.id).isEmpty()) d.dismiss() else fill()
                }, LinearLayout.LayoutParams(dp(40), dp(40)))
                list.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
            }
        }
        fill()
        col.addView(ScrollView(this).apply { addView(list) }, LinearLayout.LayoutParams(-1, 0, 1f))
        fitInsets(col)
        d.setContentView(col)
        d.window?.setLayout(-1, -1)
        d.show()
    }

    // ---------- 菜单 ----------

    private fun showMenu(anchor: View) {
        val pm = PopupMenu(this, anchor)
        val m = pm.menu
        m.add(0, 1, 0, "新标签页")
        m.add(0, 2, 1, "前进")
        m.add(0, 3, 2, "刷新")
        m.add(0, 4, 3, "实例管理")
        m.add(0, 5, 4, "节点与出口")
        m.add(0, 6, 5, "扩展")
        m.add(0, 7, 6, "设置")
        pm.setOnMenuItemClickListener {
            val t = Core.curTab()
            when (it.itemId) {
                1 -> Core.openTab(Core.store.current)
                2 -> t?.session?.goForward()
                3 -> t?.session?.reload()
                4 -> openSheet("instances", true)
                5 -> openSheet("node", true)
                6 -> openSheet("addons", true)
                7 -> openSheet("settings", true)
            }
            true
        }
        pm.show()
    }

    /** 返回：先关弹出的页面，再网页后退，再关多余的标签，最后退到后台（不结束进程，后台实例保持）。 */
    private fun handleBack() {
        if (sheet != null) { closeSheet(); return }
        val t = Core.curTab()
        when {
            t != null && t.canBack -> t.session.goBack()
            t != null && Core.tabsOf(t.inst).size > 1 -> Core.closeTab(t)
            else -> moveTaskToBack(true)
        }
    }

    @Deprecated("安卓 13 以下的返回键")
    @Suppress("DEPRECATION")
    override fun onBackPressed() = handleBack()
}
