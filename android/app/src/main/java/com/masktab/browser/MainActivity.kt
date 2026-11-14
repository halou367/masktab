package com.masktab.browser

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import org.json.JSONObject
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
// 点头像打开实例菜单（内置扩展页面 app.html#menu，复用桌面 menu.js）。
//
// 内置页面（菜单、实例管理、节点、指纹、设置、扩展）怎么显示（第三版，决策 A-8）：
// 全应用只有一个 GeckoView。内置页面用一个常驻的会话 [panel]（启动时就把 app.html 载好），要显示时把它换进这个 GeckoView，
// 关掉时换回当前标签页——和切换标签页是同一条路。页面之间跳转只是改地址 # 后面的路由，不新建也不销毁任何窗口、视图、会话。
// 以前每开一页就新建一个对话框 + GeckoView + 会话、关掉时全部销毁；模拟器里没事，真机上从菜单点任何一项（都要先关菜单再开下一页）
// 会白屏或闪退（用户两次反馈）。真机原因没有拿到日志确认，所以换成这条不创建、不销毁绘制表面的路，并加了不依赖内置页面的诊断入口。

class MainActivity : Activity(), CoreUi {
    private lateinit var gecko: GeckoView
    private lateinit var url: EditText
    private lateinit var tabCount: TabCountView
    private lateinit var avatar: AvatarView
    private lateinit var progress: ProgressBar
    private var startup: StartupView? = null
    private lateinit var toolbar: View
    private var panel: GeckoSession? = null   // 内置页面专用的常驻会话
    private var panelOn = false               // 现在显示的是不是内置页面
    private var panelRoute = ""               // app 让它显示的路由
    private var panelCur = ""                 // 页面现在所在的路由（页面自己也会换，例如从菜单点进某一页）
    private var panelRetry = 0
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
        // 上次是崩溃 / 无响应 / 被系统杀掉的：开头就问要不要看诊断信息（不依赖内置页面，白屏时也能用）
        bg { val why = Diag.lastBadExit(this); if (why != null) ui { askDiag(why) } }
    }

    override fun onDestroy() {
        if (Core.ui === this) Core.ui = null
        panelOn = false
        try { gecko.releaseSession() } catch (e: Exception) { logw("释放会话出错", e) }
        try { panel?.close() } catch (e: Exception) { logw("关闭内置页面会话出错", e) }
        panel = null
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 测试用的启动参数（CI 截图）：mt_open=menu|instances|…打开对应页面，close 收起，diag 打开诊断窗口；mt_inst=<实例id 或 #编号> 切换实例；mt_hold 让启动页停留。外部链接（VIEW）在当前实例打开。 */
    private fun handleIntent(i: Intent?) {
        if (i == null || !Core.started) return
        if (i.action == Intent.ACTION_VIEW && i.data != null) { closeSheet(); Core.openTab(Host.current, i.dataString); return }
        if (i.getBooleanExtra("mt_hold", false)) return
        if (hold) { hold = false; hideStartup() }
        i.getStringExtra("mt_inst")?.let { v -> closeSheet(); Core.switchTo(if (v.startsWith("#")) Host.insts.firstOrNull { it.no == v.drop(1).toIntOrNull() }?.id ?: v else v) }
        i.getStringExtra("mt_open")?.let { r -> when (r) { "diag" -> showDiag(); "close" -> closeSheet(); else -> openSheet(r, r != "menu") } }
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
        avatar.setOnLongClickListener { showDiag(); true } // 长按头像：诊断信息（原生窗口）
        val dots = DotsView(this).apply { tint = ink }
        tb.addView(iconBtn(dots, "菜单") { showMenu(dots) }, LinearLayout.LayoutParams(dp(40), dp(44)))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.INVISIBLE }
        // 地址栏和进度条包在一起：显示内置页面时整块藏起来（页面自己有标题和返回）
        toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(tb, LinearLayout.LayoutParams(-1, -2))
            addView(progress, LinearLayout.LayoutParams(-1, dp(3)))
        }
        col.addView(toolbar, LinearLayout.LayoutParams(-1, -2))
        gecko = GeckoView(this)
        col.addView(gecko, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(col, FrameLayout.LayoutParams(-1, -1))
        fitInsets(col)
        if (!Core.started) {
            startup = StartupView(this, Bridge.LAUNCH_STEPS).also { sv ->
                // 启动页底部：版本号 + 诊断入口（启动卡住时也能点）
                sv.addView(TextView(this).apply {
                    text = "版本 ${Diag.version(this@MainActivity)} · 诊断信息"
                    textSize = 12f; setTextColor(Color.parseColor("#80868B")); gravity = Gravity.CENTER
                    setPadding(dp(16), dp(28), dp(16), dp(12))
                    setOnClickListener { showDiag() }
                }, LinearLayout.LayoutParams(-2, -2))
            }
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
        val target = if (isUrl) (if (q.contains("://")) q else "https://$q") else Host.searchUrl.replace("%s", java.net.URLEncoder.encode(q, "UTF-8"))
        val t = Core.curTab()
        if (t == null) Core.openTab(Host.current, target) else t.session.loadUri(target)
        url.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(url.windowToken, 0)
        gecko.requestFocus()
    }

    override fun onTabsChanged() {
        val i = Host.cur() ?: return
        val t = Core.curTab()
        // 正显示内置页面时不动 GeckoView 里的会话（关掉页面时再换回标签页）
        if (!panelOn && t != null && shown !== t.session) {
            gecko.releaseSession()
            for ((_, l) in Core.tabs) for (x in l) if (x !== t) x.session.setActive(false)
            panel?.let { if (it.isOpen) it.setActive(false) }
            gecko.setSession(t.session)
            t.session.setActive(true)
            shown = t.session
        }
        tabCount.count = Core.tabsOf(i.id).size
        avatar.set(parseColor(i.color), i.no.toString(), flagBitmap(this, i.country.takeIf { i.on && it.isNotEmpty() }))
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
                // 核心服务（和电脑版同一份代码，连同它管的 mihomo）
                step(2, 1)
                if (!CoreProc.start()) { step(2, 4, CoreProc.lastError); step(3, 3); step(4, 3); return@bg }
                Host.waitFor(15000) { Host.mihomoOk || Host.coreError.isNotEmpty() }
                Legacy.migrate(this@MainActivity)?.let { msg -> Host.refresh(); toast(msg) }
                pace(s)
                step(2, if (Host.mihomoOk) 2 else 4, if (Host.mihomoOk) "mihomo ${Host.mihomoVersion}" else Host.coreError.ifEmpty { "mihomo 没有起来" })
                // 订阅
                s = System.currentTimeMillis()
                if (Host.subs.isEmpty()) step(3, 3, "还没有订阅，全部实例直连") else { pace(s); step(3, if (Host.nodeCount > 0) 2 else 4, if (Host.nodeCount > 0) "${Host.nodeCount} 个节点" else "订阅里还没有节点") }
                // 网络检测：启动当前实例（选线、写配置、探出口）
                s = System.currentTimeMillis()
                step(4, 1)
                if (Host.insts.isEmpty()) try { CoreProc.json("POST", "/api/instances", JSONObject()) } catch (e: Exception) { logw("新建第一个实例失败：${e.message}") }
                Host.refresh()
                val cur = Host.cur()
                if (cur != null) {
                    Host.saveCurrent(cur.id)
                    try { CoreProc.json("POST", "/api/instances/${cur.id}/launch") } catch (e: Exception) { logw("启动实例失败：${e.message}") }
                    Host.waitFor(25000) { Host.get(cur.id)?.let { it.running && !it.starting && (it.country.isNotEmpty() || it.error.isNotEmpty()) } ?: true }
                }
                val i = Host.cur()
                pace(s)
                step(4, if (i != null && i.country.isNotEmpty()) 2 else 4,
                    if (i == null) "没有实例" else if (i.country.isNotEmpty()) "#${i.no} 出口 ${i.country} · ${i.ip}" + (if (!i.on) "（直连）" else "") else i.error.ifEmpty { if (i.running) "出口还没探出来" else "实例没有启动好" })
                Thread.sleep(500)
                ui {
                    logi("启动完成，用时 ${System.currentTimeMillis() - t0} 毫秒")
                    Core.started = true
                    Host.watch()
                    Core.pushState()
                    Core.restoreTabs()
                    if (!hold) hideStartup()
                    preloadPanel()
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

    /** 内置页面的常驻会话：没有就建一个（只在第一次、或它崩溃之后）。 */
    private fun ensurePanel(): GeckoSession {
        panel?.let { if (it.isOpen) return it }
        val s = GeckoSession()
        s.promptDelegate = PromptBridge
        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
                // 菜单 / 管理页里点到的外部链接在当前实例的新标签页打开
                if (request.uri.startsWith("http")) { val u = request.uri; mainHandler.post { closeSheet(); Core.openTab(Host.current, u) }; return GeckoResult.deny() }
                return null
            }
            override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
                panelCur = url?.substringAfter('#', "") ?: ""
            }
            override fun onLoadError(session: GeckoSession, uri: String?, error: org.mozilla.geckoview.WebRequestError): GeckoResult<String>? {
                logw("内置页面打不开 $uri 类别 ${error.category} 代码 ${error.code}")
                Core.pageLog("内置页面打不开 ${uri?.substringAfterLast('/')} 代码 ${error.code}")
                return null
            }
        }
        s.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onCloseRequest(session: GeckoSession) { if (panel === session) closeSheet() }
            override fun onCrash(session: GeckoSession) { panelDied(session, "崩溃") }
            override fun onKill(session: GeckoSession) { panelDied(session, "被系统回收") }
        }
        s.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStop(session: GeckoSession, success: Boolean) { if (!success) logw("内置页面加载失败 $panelRoute") }
        }
        Core.ext?.let { s.webExtensionController.setMessageDelegate(it, Core.sessionMsg(null), Core.NATIVE) }
        s.open(Core.ensureRuntime())
        panel = s
        return s
    }

    /** 启动完成后先把内置页面载好（停在空路由 idle），之后每次打开只是换路由，不用等加载。 */
    private fun preloadPanel() {
        if (Core.baseUrl.isEmpty() || isFinishing || isDestroyed) return
        try { val s = ensurePanel(); if (!panelOn) { s.loadUri(Core.pageUrl("idle")); s.setActive(false) } } catch (e: Throwable) { logw("预载内置页面出错", e); Core.pageLog("预载内置页面出错：${e.message}") }
    }

    override fun openSheet(route: String, full: Boolean) { panelRetry = 0; showPanel(route) }

    private fun showPanel(route: String) {
        if (!Core.started || Core.baseUrl.isEmpty() || isFinishing || isDestroyed) return
        try {
            val s = ensurePanel()
            panelRoute = route
            s.loadUri(Core.pageUrl(route))
            if (!panelOn || shown !== s) {
                panelOn = true
                url.clearFocus()
                (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(url.windowToken, 0)
                gecko.releaseSession()
                for ((_, l) in Core.tabs) for (x in l) x.session.setActive(false)
                gecko.setSession(s)
                s.setActive(true)
                shown = s
                toolbar.visibility = View.GONE
                gecko.requestFocus()
            }
            logi("内置页面 $route")
        } catch (e: Throwable) {
            logw("内置页面打不开 $route", e)
            Core.pageLog("内置页面打不开 $route：$e")
            panelOn = false
            toolbar.visibility = View.VISIBLE
            shown = null
            onTabsChanged()
            toast("页面打不开：${e.message ?: e}（长按头像可看诊断信息）")
        }
    }

    private fun panelDied(session: GeckoSession, why: String) {
        if (panel !== session) return
        logw("内置页面$why：$panelRoute（第 ${panelRetry + 1} 次）")
        Core.pageLog("内置页面$why：$panelRoute")
        val r = panelRoute
        val was = panelOn
        panel = null
        if (was) { closeSheet(); if (panelRetry++ < 2) mainHandler.postDelayed({ showPanel(r) }, 400) else toast("页面打不开（$why），长按头像可看诊断信息") }
    }

    override fun closeSheet() {
        if (!panelOn) return
        panelOn = false
        toolbar.visibility = View.VISIBLE
        // 页面回到空路由：停掉它的轮询；下次打开一定是一次路由变化，页面会重新取状态重画
        try { panel?.let { if (it.isOpen) { it.loadUri(Core.pageUrl("idle")); it.setActive(false) } } } catch (e: Exception) { logw("内置页面收起出错", e) }
        if (Core.curTab() == null) { try { gecko.releaseSession() } catch (e: Exception) { logw("释放会话出错", e) }; shown = null }
        onTabsChanged()
    }

    // ---------- 诊断信息（原生窗口，不依赖内置页面：白屏、卡在启动页时也能用） ----------

    private fun showDiag() {
        val tv = TextView(this).apply {
            text = "正在收集…"; textSize = 11f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#202124"))
            setTextIsSelectable(true); setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        var text = ""
        val d = android.app.AlertDialog.Builder(this)
            .setTitle("诊断信息")
            .setView(ScrollView(this).apply { addView(tv) })
            .setPositiveButton("复制", null)
            .setNeutralButton("分享", null)
            .setNegativeButton("关闭", null)
            .create()
        d.setOnShowListener {
            d.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (text.isEmpty()) return@setOnClickListener
                (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("MaskTab 诊断信息", text))
                Toast.makeText(this, "已复制，粘贴发给开发者", Toast.LENGTH_SHORT).show()
            }
            d.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                if (text.isEmpty()) return@setOnClickListener
                try { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "发送诊断信息")) } catch (e: Exception) { toast("没有可用的应用") }
            }
        }
        try { d.show() } catch (e: Exception) { logw("诊断窗口打不开", e); return }
        bg {
            val t = try { Diag.collect(this) } catch (e: Throwable) { "收集诊断信息出错：$e" }
            ui { text = t; tv.text = t; logi("诊断信息已收集 ${t.length} 字") }
        }
    }

    private fun askDiag(why: String) {
        if (isFinishing || isDestroyed) return
        try {
            android.app.AlertDialog.Builder(this)
                .setTitle("上次没有正常退出")
                .setMessage("$why\n\n把诊断信息复制发给开发者，可以定位原因。以后也可以长按右上角头像、或点 ⋮ → 诊断信息 打开。")
                .setPositiveButton("看诊断信息") { _, _ -> showDiag() }
                .setNegativeButton("不用", null)
                .show()
        } catch (e: Exception) { logw("提示窗口打不开", e) }
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
        val i = Host.cur() ?: return
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
        m.add(0, 8, 7, "诊断信息（${Diag.version(this)}）")
        pm.setOnMenuItemClickListener {
            val t = Core.curTab()
            when (it.itemId) {
                1 -> Core.openTab(Host.current)
                2 -> t?.session?.goForward()
                3 -> t?.session?.reload()
                4 -> openSheet("instances", true)
                5 -> openSheet("node", true)
                6 -> openSheet("addons", true)
                7 -> openSheet("settings", true)
                8 -> showDiag()
            }
            true
        }
        pm.show()
    }

    /** 返回：先关弹出的页面，再网页后退，再关多余的标签，最后退到后台（不结束进程，后台实例保持）。 */
    private fun handleBack() {
        if (panelOn) {
            // 从菜单点进去的页面：返回键先回菜单；其它情况收起
            val p = panel
            if (panelRoute == "menu" && panelCur.isNotEmpty() && panelCur != "menu" && panelCur != "idle" && p != null && p.isOpen) p.loadUri(Core.pageUrl("menu")) else closeSheet()
            return
        }
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
