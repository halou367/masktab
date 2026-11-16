package com.masktab.browser

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView

// 唯一的 Activity：照安卓 Chrome 的深色样子（决策 UI-1）。顶部一条工具栏：主页、地址栏（新标签页上没有）、实例头像（右下角国旗）、标签页数、三点菜单；
// 手机底部不放工具栏。浮在网页上的三样——头像菜单（底部弹出）、三点菜单、标签页切换器——是浏览器外壳，原生画（决策 UI-2）；
// 内置页面（设置、节点与出口、指纹与伪装、实例、订阅与地址库、扩展、诊断…）是共用的扩展页面，和电脑版同一份代码。
//
// 内置页面怎么显示（第三版，决策 A-8）：全应用只有一个 GeckoView。内置页面用一个常驻的会话 [panel]（启动时就把 app.html 载好），要显示时把它换进这个 GeckoView，
// 关掉时换回当前标签页——和切换标签页是同一条路。页面之间跳转只是改地址 # 后面的路由，不新建也不销毁任何窗口、视图、会话。
//
// 全面屏（决策 UI-4）：内容贴着系统给的 insets（状态栏、刘海、导航栏 / 手势条、键盘）摆，露出来的那一圈由 [BarsLayout] 按当前页面和主题涂色；
// 状态栏、导航栏的图标深浅跟着底色换。浮层盖住整个窗口（连两条栏），遮罩压暗时两条栏一起变暗。

class MainActivity : Activity(), CoreUi {
    private lateinit var root: BarsLayout
    private lateinit var col: LinearLayout
    private lateinit var gecko: TouchGecko
    private lateinit var pull: PullRefresh
    private lateinit var url: EditText
    private lateinit var urlBox: FrameLayout
    private lateinit var spacer: View
    private lateinit var home: ImageView
    private lateinit var tabCount: TabCountView
    private lateinit var avatar: AvatarView
    private lateinit var dots: DotsView
    private lateinit var progress: ProgressBar
    private lateinit var tb: LinearLayout
    private var startup: StartupView? = null
    private lateinit var toolbar: View
    private var panel: GeckoSession? = null   // 内置页面专用的常驻会话
    private var panelOn = false               // 现在显示的是不是内置页面
    private var panelRoute = ""               // app 让它显示的路由
    private var panelRetry = 0
    private var shown: GeckoSession? = null
    private var hold = false
    private var overlay: Overlay? = null
    private var pal = Theme.DARK
    private var themeKey = ""
    // 页面报上来的：盖了遮罩 / 底部有表单（决策 UI-4）
    private var pageDim = false; private var pageSheet = false
    private var ntpDim = false; private var ntpSheet = false
    private var inTop = 0; private var inBottom = 0; private var inLeft = 0; private var inRight = 0; private var inIme = 0
    override var prompts: Prompts? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Core.init(this)
        Core.ui = this
        prompts = Prompts(this)
        edgeToEdge()
        hold = intent?.getBooleanExtra("mt_hold", false) == true
        pal = Theme.pal(this, seedColor())
        setContentView(buildUi())
        applyTheme(true)
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

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyTheme() // “跟随系统”时系统切了深浅色
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 测试用的启动参数（CI 截图）：mt_open=menu（头像菜单）|appmenu（三点菜单）|tabs（标签页切换器）|close|diag|其余是内置页面的路由；mt_inst=<实例id 或 #编号> 切换实例；mt_hold 让启动页停留。外部链接（VIEW）在当前实例打开。 */
    private fun handleIntent(i: Intent?) {
        if (i == null || !Core.started) return
        if (i.action == Intent.ACTION_VIEW && i.data != null) { closeOverlay(); closeSheet(); Core.openTab(Host.current, i.dataString); return }
        if (i.getBooleanExtra("mt_hold", false)) return
        if (hold) { hold = false; hideStartup() }
        i.getStringExtra("mt_inst")?.let { v -> closeOverlay(); closeSheet(); Core.switchTo(if (v.startsWith("#")) Host.insts.firstOrNull { it.no == v.drop(1).toIntOrNull() }?.id ?: v else v) }
        i.getStringExtra("mt_open")?.let { r ->
            when (r) {
                "diag" -> showDiag()
                "close" -> { closeOverlay(); closeSheet() }
                "menu" -> { closeSheet(); showAvatarMenu() }
                "appmenu" -> { closeSheet(); showAppMenu() }
                "tabs" -> { closeSheet(); showTabs() }
                else -> { closeOverlay(); openSheet(r, true) }
            }
        }
        i.removeExtra("mt_open")
        i.removeExtra("mt_inst")
    }

    // ---------- 全面屏：insets 与两条系统栏 ----------

    private fun edgeToEdge() {
        val w = window
        if (Build.VERSION.SDK_INT >= 30) w.setDecorFitsSystemWindows(false)
        @Suppress("DEPRECATION")
        run {
            w.statusBarColor = Color.TRANSPARENT
            w.navigationBarColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT < 30) w.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        if (Build.VERSION.SDK_INT >= 29) { w.isStatusBarContrastEnforced = false; w.isNavigationBarContrastEnforced = false }
        if (Build.VERSION.SDK_INT >= 28) w.attributes = w.attributes.apply {
            layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    /** 系统给的 insets：状态栏 + 刘海（上、左、右）、导航栏 / 手势条（下）、键盘。内容按它们留边；浮层各自按它们留边。 */
    private fun onInsets(ins: WindowInsets) {
        if (Build.VERSION.SDK_INT >= 30) {
            val b = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            inTop = b.top; inBottom = b.bottom; inLeft = b.left; inRight = b.right
            inIme = ins.getInsets(WindowInsets.Type.ime()).bottom
        } else {
            @Suppress("DEPRECATION")
            run { inTop = ins.systemWindowInsetTop; inLeft = ins.systemWindowInsetLeft; inRight = ins.systemWindowInsetRight; inBottom = minOf(ins.systemWindowInsetBottom, ins.stableInsetBottom); inIme = ins.systemWindowInsetBottom }
            if (Build.VERSION.SDK_INT >= 28) ins.displayCutout?.let { inTop = maxOf(inTop, it.safeInsetTop); inLeft = maxOf(inLeft, it.safeInsetLeft); inRight = maxOf(inRight, it.safeInsetRight) }
        }
        root.insetTop = inTop; root.insetBottom = inBottom; root.insetLeft = inLeft; root.insetRight = inRight
        col.setPadding(inLeft, inTop, inRight, maxOf(inBottom, inIme))
        startup?.insets(inTop, inBottom, inLeft, inRight)
        overlay?.let { fitOverlay(it) }
        root.invalidate()
    }

    /** 状态栏、导航栏的底色和图标深浅，按现在显示的东西算（决策 UI-4）。 */
    private fun applyBars() {
        val bg = pal.bg
        val dimmed = Theme.over(bg, pal.scrim)
        var top = bg; var bottom = bg
        when {
            startup != null -> {}
            panelOn -> { top = if (pageDim) dimmed else bg; bottom = if (pageSheet) pal.surf else if (pageDim) dimmed else bg }
            isNtp(Core.curTab()) -> { bottom = if (ntpSheet) pal.surf else if (ntpDim) dimmed else bg }
        }
        root.paint(top, bottom)
        barIcons(Theme.isLight(if (overlay != null && overlay!!.tag == "dim") Theme.over(top, pal.scrim) else top), Theme.isLight(bottom))
    }

    private fun barIcons(lightTop: Boolean, lightBottom: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController ?: return
            val f = (if (lightTop) WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS else 0) or (if (lightBottom) WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS else 0)
            c.setSystemBarsAppearance(f, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        } else {
            @Suppress("DEPRECATION")
            run {
                var f = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                if (lightTop) f = f or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                if (lightBottom) f = f or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                window.decorView.systemUiVisibility = f
            }
        }
    }

    override fun pageBars(src: String, dim: Boolean, sheet: Boolean) {
        if (src == "panel") { pageDim = dim; pageSheet = sheet } else { ntpDim = dim; ntpSheet = sheet }
        applyBars()
    }

    /** 当前实例的颜色（强调色跟着它走，决策 UI-10）；还没有实例时用默认的蓝。 */
    private fun seedColor(): Int? = try { Host.cur()?.let { parseColor(it.color) } } catch (e: Exception) { null }

    /** 主题（设置里的“外观”）变了、换了实例，或第一次：重涂外壳。 */
    private fun applyTheme(force: Boolean = false) {
        val seed = seedColor()
        val p = Theme.pal(this, seed)
        val key = (if (p.dark) "d" else "l") + (seed ?: 0)
        if (!force && key == themeKey) return
        themeKey = key; pal = p
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(p.bg))
        tb.setBackgroundColor(p.bg)
        col.setBackgroundColor(p.bg)
        urlBox.background = rounded(p.pill, dp(24).toFloat())
        url.setTextColor(p.on); url.setHintTextColor(p.on2)
        home.setImageDrawable(mi("ext", p.on))
        tabCount.tint = p.on; tabCount.invalidate()
        dots.tint = p.on; dots.invalidate()
        avatar.ring = p.bg; avatar.invalidate()
        progress.progressTintList = android.content.res.ColorStateList.valueOf(p.acc)
        progress.progressBackgroundTintList = android.content.res.ColorStateList.valueOf(p.bg)
        gecko.coverUntilFirstPaint(p.bg)
        applyBars()
    }

    // ---------- 界面 ----------

    private fun btn(v: View, desc: String, onClick: () -> Unit): View {
        v.contentDescription = desc
        v.setOnClickListener { onClick() }
        v.ripple(true)
        return v
    }

    private fun buildUi(): View {
        root = BarsLayout(this)
        col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        tb = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
        }
        // 顺序照定稿的演示（决策 UI-10）：头像（当前实例，带国旗）在最左，地址栏，扩展，标签页数，三点
        avatar = AvatarView(this).apply { scale = 0.68f }
        tb.addView(btn(avatar, "实例") { showAvatarMenu() }, LinearLayout.LayoutParams(dp(48), dp(48)))
        avatar.setOnLongClickListener { showDiag(); true } // 长按头像：诊断信息（原生窗口）
        url = EditText(this).apply {
            hint = "搜索或输入网址"
            setSingleLine()
            textSize = 16f
            background = null
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
        urlBox = FrameLayout(this).apply { addView(url, FrameLayout.LayoutParams(-1, -1)) }
        tb.addView(urlBox, LinearLayout.LayoutParams(0, dp(48), 1f).apply { leftMargin = dp(4); rightMargin = dp(4) })
        spacer = View(this)
        tb.addView(spacer, LinearLayout.LayoutParams(0, dp(48), 1f))
        home = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER }
        tb.addView(btn(home, "扩展程序") { if (Core.started) openSheet("addons", true) }, LinearLayout.LayoutParams(dp(44), dp(48)))
        tabCount = TabCountView(this)
        tb.addView(btn(tabCount, "标签页") { showTabs() }, LinearLayout.LayoutParams(dp(48), dp(48)))
        dots = DotsView(this)
        tb.addView(btn(dots, "更多选项") { showAppMenu() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.INVISIBLE }
        // 工具栏和进度条包在一起：显示内置页面时整块藏起来（页面自己有标题和返回）
        toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(tb, LinearLayout.LayoutParams(-1, dp(64)))
            addView(progress, LinearLayout.LayoutParams(-1, dp(3)).apply { topMargin = -dp(3) })
        }
        col.addView(toolbar, LinearLayout.LayoutParams(-1, -2))
        gecko = TouchGecko(this)
        pull = PullRefresh(this, gecko) { pal }
        pull.atTop = { (Core.curTab()?.scrollY ?: 0) <= 0 }
        pull.onRefresh = { Core.curTab()?.session?.reload() }
        col.addView(pull, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(col, FrameLayout.LayoutParams(-1, -1))
        root.setOnApplyWindowInsetsListener { _, ins -> onInsets(ins); ins }
        if (!Core.started) {
            startup = StartupView(this, Bridge.LAUNCH_STEPS, pal).also { sv ->
                // 启动页底部：版本号 + 诊断入口（启动卡住时也能点）
                sv.content.addView(TextView(this).apply {
                    text = "版本 ${Diag.version(this@MainActivity)} · 诊断信息"
                    textSize = 12f; setTextColor(pal.on3); gravity = Gravity.CENTER
                    setPadding(dp(16), dp(28), dp(16), dp(12))
                    setOnClickListener { showDiag() }
                }, LinearLayout.LayoutParams(-2, -2))
            }
            root.addView(startup, FrameLayout.LayoutParams(-1, -1))
        }
        return root
    }

    private fun isNtp(t: Tab?): Boolean = t != null && (t.url.isEmpty() || (Core.isInternal(t.url) && t.url.contains("newtab.html")))

    private fun showUrl() {
        val t = Core.curTab()
        if (!url.hasFocus()) {
            val u = t?.url ?: ""
            url.setText(if (Core.isInternal(u) || u.isEmpty()) "" else u.removePrefix("https://").removePrefix("http://").removeSuffix("/"))
        }
        // 新标签页上没有地址栏（搜索框在页面里），只留主页、头像、标签页数、三点菜单
        val ntp = isNtp(t) && !url.hasFocus()
        urlBox.visibility = if (ntp) View.GONE else View.VISIBLE
        spacer.visibility = if (ntp) View.VISIBLE else View.GONE
        pull.enabled2 = !panelOn && t != null && !ntp && !Core.isInternal(t.url)
    }

    private fun go(input: String) {
        val q = input.trim()
        if (q.isEmpty()) return
        val isUrl = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(q) || (Regex("^[^\\s]+\\.[^\\s]{2,}$").matches(q))
        val target = if (isUrl) (if (q.contains("://")) q else "https://$q") else Host.searchUrl.replace("%s", java.net.URLEncoder.encode(q, "UTF-8"))
        val t = Core.curTab()
        if (t == null) Core.openTab(Host.current, target) else t.session.loadUri(target)
        url.clearFocus()
        hideIme()
        gecko.requestFocus()
    }

    private fun hideIme() { (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(url.windowToken, 0) }

    override fun onTabsChanged() {
        val i = Host.cur() ?: return
        applyTheme()
        val t = Core.curTab()
        // 正显示内置页面时不动 GeckoView 里的会话（关掉页面时再换回标签页）
        if (!panelOn && t != null && shown !== t.session) {
            pull.done()
            gecko.releaseSession()
            for ((_, l) in Core.tabs) for (x in l) if (x !== t) x.session.setActive(false)
            panel?.let { if (it.isOpen) it.setActive(false) }
            gecko.setSession(t.session)
            t.session.setActive(true)
            shown = t.session
            ntpDim = false; ntpSheet = false
        }
        tabCount.count = Core.tabsOf(i.id).size
        avatar.set(parseColor(i.color), i.no.toString(), flagBitmap(this, i.country.takeIf { i.on && it.isNotEmpty() }))
        avatar.contentDescription = "实例 #${i.no} ${i.name}"
        t?.let { onTabUpdated(it) }
        applyBars()
    }

    override fun onTabUpdated(t: Tab) {
        if (t !== Core.curTab()) return
        showUrl()
        progress.progress = t.progress
        progress.visibility = if (t.progress in 1..99) View.VISIBLE else View.INVISIBLE
        applyBars()
    }

    override fun onPageStopped(t: Tab) { if (t === Core.curTab()) pull.done() }

    override fun toast(msg: String) = ui { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    // ---------- 启动 ----------

    private fun boot() {
        val st = startup!!
        val t0 = System.currentTimeMillis()
        fun step(k: Int, s: Int, d: String = "") { logi("启动步骤 ${k + 1} ${Bridge.LAUNCH_STEPS[k]}：$s $d（${System.currentTimeMillis() - t0} 毫秒）"); ui { st.set(k, s, d) } }
        step(0, 1)
        try { Core.ensureRuntime() } catch (e: Throwable) { step(0, 4, e.message ?: "内核启动失败"); return }
        step(0, 2, "GeckoView " + (GeckoSession.getDefaultUserAgent().substringAfter("rv:").substringBefore(")")))
        // 核心服务（和电脑版同一份代码，连同它管的 mihomo）和内置扩展互不依赖：一起开始，不再等扩展装好才起核心服务（decisions A-13）
        val coreUp = java.util.concurrent.CountDownLatch(1)
        val coreOk = java.util.concurrent.atomic.AtomicBoolean(false)
        bg {
            try {
                coreOk.set(CoreProc.start())
                if (coreOk.get()) {
                    Host.waitFor(15000) { Host.mihomoOk || Host.coreError.isNotEmpty() }
                    Legacy.migrate(this@MainActivity)?.let { msg -> Host.refresh(); toast(msg) }
                }
            } finally { coreUp.countDown() }
        }
        step(1, 1)
        Core.ensureExt { err ->
            if (err != null) { step(1, 4, err); return@ensureExt }
            step(1, 2)
            bg {
                step(2, 1)
                coreUp.await()
                if (!coreOk.get()) { step(2, 4, CoreProc.lastError); step(3, 3); step(4, 3); return@bg }
                ui { applyTheme() } // 设置里的“外观”现在才知道
                step(2, if (Host.mihomoOk) 2 else 4, if (Host.mihomoOk) "mihomo ${Host.mihomoVersion}" else Host.coreError.ifEmpty { "mihomo 没有起来" })
                // 订阅：用核心服务存着的（启动时不下载）
                if (Host.subs.isEmpty()) step(3, 3, "还没有订阅，全部实例直连") else step(3, if (Host.nodeCount > 0) 2 else 4, if (Host.nodeCount > 0) "${Host.nodeCount} 个节点" else "订阅里还没有节点")
                // 网络检测：启动当前实例。线路和上次一样时核心服务先用上次的出口，马上就绪，后台再确认（decisions A-13）
                step(4, 1)
                if (Host.insts.isEmpty()) try { CoreProc.json("POST", "/api/instances", JSONObject()) } catch (e: Exception) { logw("新建第一个实例失败：${e.message}") }
                Host.refresh()
                val cur = Host.cur()
                if (cur != null) {
                    ui { st.showInst(parseColor(cur.color), cur.no.toString(), null) }
                    Host.saveCurrent(cur.id)
                    try { CoreProc.json("POST", "/api/instances/${cur.id}/launch") } catch (e: Exception) { logw("启动实例失败：${e.message}") }
                    Host.waitFor(25000) { Host.get(cur.id)?.let { it.running && !it.starting && (it.country.isNotEmpty() || it.error.isNotEmpty()) } ?: true }
                }
                val i = Host.cur()
                if (i != null && i.country.isNotEmpty()) ui { st.showInst(parseColor(i.color), i.no.toString(), flagBitmap(this, i.country.takeIf { i.on })) }
                step(4, if (i != null && i.country.isNotEmpty()) 2 else 4,
                    if (i == null) "没有实例" else if (i.country.isNotEmpty()) "#${i.no} 出口 ${i.country} · ${i.ip}" + (if (!i.on) "（直连）" else "") else i.error.ifEmpty { if (i.running) "出口还没探出来" else "实例没有启动好" })
                Thread.sleep(250) // 让最后一步的勾显示一下
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
        applyBars()
    }

    // ---------- 内置页面（设置、节点与出口等） ----------

    /** 内置页面的常驻会话：没有就建一个（只在第一次、或它崩溃之后）。 */
    private fun ensurePanel(): GeckoSession {
        panel?.let { if (it.isOpen) return it }
        val s = GeckoSession()
        s.promptDelegate = PromptBridge
        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny>? {
                // 设置页里点到的外部链接在当前实例的新标签页打开
                if (request.uri.startsWith("http")) { val u = request.uri; mainHandler.post { closeSheet(); Core.openTab(Host.current, u) }; return GeckoResult.deny() }
                return null
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

    override fun openSheet(route: String, full: Boolean) {
        if (route == "menu") { showAvatarMenu(); return } // 头像菜单是原生的（决策 UI-2）
        panelRetry = 0; showPanel(route)
    }

    private fun showPanel(route: String) {
        if (!Core.started || Core.baseUrl.isEmpty() || isFinishing || isDestroyed) return
        try {
            closeOverlay()
            val s = ensurePanel()
            panelRoute = route
            s.loadUri(Core.pageUrl(route))
            if (!panelOn || shown !== s) {
                panelOn = true
                pageDim = false; pageSheet = false
                url.clearFocus()
                hideIme()
                pull.done()
                gecko.releaseSession()
                for ((_, l) in Core.tabs) for (x in l) x.session.setActive(false)
                gecko.setSession(s)
                s.setActive(true)
                shown = s
                toolbar.visibility = View.GONE
                pull.enabled2 = false
                gecko.requestFocus()
            }
            applyBars()
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

    // ---------- 浮层：头像菜单、三点菜单、标签页切换器（原生，决策 UI-2） ----------

    private fun newOverlay(dim: Boolean): Overlay {
        closeOverlay()
        overlayFit = null
        url.clearFocus(); hideIme()
        lateinit var o: Overlay
        // 点遮罩关掉的（不经 closeOverlay）也要把 overlay 清掉，免得下一次返回键白按一次
        o = Overlay(this, pal, dim) { if (overlay === o) overlay = null; applyBars() }
        o.tag = if (dim) "dim" else ""
        overlay = o
        root.addView(o, FrameLayout.LayoutParams(-1, -1))
        applyBars()
        return o
    }
    private fun closeOverlay() { val o = overlay ?: return; overlay = null; o.close(); applyBars() }
    /** 浮层里的卡片怎么按 insets 留边（各浮层自己给）。 */
    private var overlayFit: (() -> Unit)? = null
    private fun fitOverlay(o: Overlay) { o.setPadding(inLeft, 0, inRight, 0); overlayFit?.invoke() }

    private fun surface(color: Int, top: Float, bottom: Float) = GradientDrawable().apply { setColor(color); cornerRadii = floatArrayOf(top, top, top, top, bottom, bottom, bottom, bottom) }

    private fun flagView(cc: String, w: Int = 20): View? = flagBitmap(this, cc.takeIf { it.isNotEmpty() })?.let { b ->
        ImageView(this).apply { setImageBitmap(b); scaleType = ImageView.ScaleType.CENTER_CROP; layoutParams = LinearLayout.LayoutParams(dp(w), dp(w * 3 / 4)).apply { rightMargin = dp(8) } }
    }
    private fun latColor(l: Int) = if (l in 1..199) pal.good else if (l in 200..499) pal.mid else if (l == 0) pal.on3 else pal.bad
    private fun avatarOf(i: Inst, size: Int, ring: Int, dot: Boolean = false, flag: Boolean = true) = AvatarView(this).apply {
        set(parseColor(i.color), i.no.toString(), if (flag) flagBitmap(this@MainActivity, i.country.takeIf { i.on && it.isNotEmpty() }) else null)
        scale = 0.84f; this.ring = ring
        if (dot) this.dot = if (i.starting) 2 else if (i.running) 1 else 3
        dotColors = intArrayOf(pal.good, pal.acc, pal.on3)
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
    }
    private fun trailText(s: String, color: Int = pal.on3) = text(s, 14f, color)
    private fun trailRow(vararg v: View?) = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; for (x in v) if (x != null) addView(x) }

    /** 一块（决策 UI-10）：每项自己一块，块和块之间留 2dp 的缝；一组里头一块、末一块的外侧是大圆角。 */
    private fun block(v: View, color: Int, first: Boolean, last: Boolean, gap: Int = 2): View {
        val big = dp(20).toFloat(); val sm = dp(4).toFloat()
        v.background = surface(color, if (first) big else sm, if (last) big else sm)
        v.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { leftMargin = dp(12); rightMargin = dp(12); topMargin = dp(gap) }
        return v
    }
    private fun chev() = icon("chevR", pal.on3, 20).apply { layoutParams = LinearLayout.LayoutParams(dp(20), dp(24)).apply { leftMargin = dp(6) } }

    /**
     * 头像菜单（底部弹出，照定稿的演示，决策 UI-10）：当前实例一张实例色的卡片；四项入口各一块；
     * “其它实例”标题右边只有“新建实例”；下面每个实例一块，点一下切换。管理实例在 三点菜单 → 设置 → 实例，导入邮箱在实例页右上角。
     */
    private fun showAvatarMenu() {
        if (!Core.started) return
        val me = Host.cur() ?: return
        closeSheet()
        val o = newOverlay(true)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; isClickable = true }
        box.addView(View(this).apply { background = rounded(pal.on3, dp(2).toFloat()); alpha = 0.6f }, LinearLayout.LayoutParams(dp(32), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(12); bottomMargin = dp(12) })
        // 当前实例
        val hero = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(16)) }
        hero.addView(avatarOf(me, 52, pal.tonal, false, false))
        val who = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(8), 0) }
        who.addView(text("#${me.no} ${me.name.ifEmpty { "未命名" }}", 17f, pal.ontonal, true))
        val line = trailRow(flagView(me.country.takeIf { me.on } ?: ""), text(if (!me.on) "直连" else me.ip.ifEmpty { if (me.error.isNotEmpty()) me.error else "出口探测中…" }, 14f, pal.ontonal).apply { typeface = Typeface.MONOSPACE },
            if (me.on && me.ip.isNotEmpty()) text("  ${if (me.latency > 0) "${me.latency} ms" else if (me.latency < 0) "不通" else ""}", 13f, latColor(me.latency)) else null)
        who.addView(line, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(4) })
        hero.addView(who, LinearLayout.LayoutParams(0, -2, 1f))
        if (me.on) {
            val rep = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            rep.addView(RingView(this, pal).apply { value = me.purity.takeIf { it >= 0 }; contentDescription = "纯净度 ${if (me.purity >= 0) me.purity else "未知"}" }, LinearLayout.LayoutParams(dp(40), dp(40)))
            rep.addView(trailRow(DotView(this, when (me.cf) { "good" -> pal.good; "bad" -> pal.bad; else -> pal.on3 }).apply { layoutParams = LinearLayout.LayoutParams(dp(8), dp(8)).apply { rightMargin = dp(5) } }, text("CF", 12f, pal.ontonal)), LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(4) })
            hero.addView(rep)
        }
        hero.background = rounded(pal.tonal, dp(20).toFloat())
        box.addView(hero, LinearLayout.LayoutParams(-1, -2).apply { leftMargin = dp(12); rightMargin = dp(12); bottomMargin = dp(6) })
        val go = { r: String -> { closeOverlay(); openSheet(r, true) } }
        fun entry(ic: String, label: String, trail: View?, first: Boolean, last: Boolean, act: () -> Unit) {
            val r = menuRow(pal, ic, label, trailRow(trail, chev()), true, 56, act)
            r.setPadding(dp(16), 0, dp(10), 0)
            box.addView(block(r, pal.surf2, first, last))
        }
        entry("key", "账号管理", trailText(if (me.accounts > 0) me.accounts.toString() else ""), true, false) { go("instances/${me.id}")() }
        entry("globe", "节点与出口", trailRow(flagView(me.country.takeIf { me.on } ?: ""), trailText(if (!me.on) "直连" else cname(me.country))), false, false) { go("node")() }
        entry("finger", "指纹与伪装", trailText(if (me.checksTotal > 0) "${me.checksPass}/${me.checksTotal}" else "", if (me.checksTotal > 0 && me.checksPass == me.checksTotal) pal.good else pal.on3), false, false) { go("fp")() }
        entry("edit", "录入登录", trailText(if (Host.rules > 0) Host.rules.toString() else ""), false, true) {
            closeOverlay()
            try { Core.bgPort?.postMessage(jsonOf("t" to "rec-start", "inst" to me.id)) } catch (e: Exception) { logw("录入登录没发出去", e) }
            toast("回到要登录的网页后开始录入")
        }
        // 其它实例：标题 + 新建
        val others = Host.insts.filter { it.id != me.id }
        val head = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(28), dp(10), dp(12), dp(4)) }
        head.addView(text("其它实例（${others.size}）", 13f, pal.on2, true), LinearLayout.LayoutParams(0, -2, 1f))
        head.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(10), 0, dp(14), 0); background = rounded(pal.tonal, dp(18).toFloat())
            addView(icon("add", pal.ontonal, 20), LinearLayout.LayoutParams(dp(20), dp(24)).apply { rightMargin = dp(4) })
            addView(text("新建实例", 14f, pal.ontonal, true))
            contentDescription = "新建实例"; ripple()
            setOnClickListener { closeOverlay(); Core.createInst() }
        }, LinearLayout.LayoutParams(-2, dp(36)).apply { leftMargin = dp(6) })
        box.addView(head)
        for ((k, x) in others.withIndex()) {
            val r = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(60); setPadding(dp(14), dp(8), dp(16), dp(8)); ripple(); contentDescription = "切换到 #${x.no}" }
            // 运行中的用它自己的颜色做底，休眠的变淡（不写“运行中 / 休眠”，决策 UI-9）
            val live = x.running || x.starting
            val bgc = if (live) Theme.over(pal.surf2, (parseColor(x.color) and 0x00FFFFFF) or (0x4D shl 24)) else pal.surf2
            r.addView(avatarOf(x, 40, bgc, true, false).apply { if (!live) alpha = 0.55f })
            val tx = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(8), 0); if (!live) alpha = 0.65f }
            tx.addView(text("#${x.no} ${x.name.ifEmpty { "未命名" }}", 15f, pal.on))
            val tabs = Core.tabsOf(x.id).size
            tx.addView(trailRow(flagView(x.country.takeIf { x.on } ?: "", 16), text(if (!x.on) "直连" else x.ip.ifEmpty { "—" }, 13f, pal.on2).apply { typeface = Typeface.MONOSPACE },
                if (tabs > 0) text("  $tabs 个标签页", 12f, pal.on2) else null), LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(2) })
            r.addView(tx, LinearLayout.LayoutParams(0, -2, 1f))
            r.setOnClickListener { closeOverlay(); Core.switchTo(x.id) }
            box.addView(block(r, bgc, k == 0, k == others.size - 1))
        }
        box.addView(View(this), LinearLayout.LayoutParams(1, dp(12)))
        val scroll = ScrollView(this).apply { addView(box); isVerticalScrollBarEnabled = false }
        val card = FrameLayout(this).apply { background = surface(pal.surf, dp(28).toFloat(), 0f); isClickable = true; addView(scroll) }
        overlayFit = { card.setPadding(0, 0, 0, inBottom + dp(8)); (card.layoutParams as? FrameLayout.LayoutParams)?.topMargin = inTop + dp(40); card.requestLayout() }
        o.addView(card, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        fitOverlay(o)
        card.translationY = resources.displayMetrics.heightPixels.toFloat()
        card.animate().translationY(0f).setDuration(260).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
        logi("头像菜单已打开")
    }

    /** 三点菜单（照定稿的演示，决策 UI-10）：顶排后退 / 前进 / 书签 / 下载 / 刷新；下面只留浏览器自己的项。实例、节点、指纹在头像菜单里，扩展在工具栏上，这里不重复。 */
    private fun showAppMenu() {
        if (!Core.started) return
        val t = Core.curTab()
        closeSheet()
        val o = newOverlay(false)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; isClickable = true; setPadding(0, 0, 0, dp(8)) }
        val web = t != null && t.url.startsWith("http")
        val marked = t != null && web && Host.bookmarks.any { it.second == t.url }
        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(15), dp(15), dp(16), dp(6)) }
        fun topBtn(ic: String, desc: String, enabled: Boolean, bg: Int, fg: Int, radius: Int, act: () -> Unit) {
            val v = ImageView(this).apply {
                setImageDrawable(mi(ic, if (enabled) fg else pal.on3)); scaleType = ImageView.ScaleType.CENTER
                background = rounded(if (enabled) bg else Theme.over(bg, Color.argb(60, 128, 128, 128)), dp(radius).toFloat())
                contentDescription = desc; isEnabled = enabled
                if (enabled) { ripple(true); setOnClickListener { closeOverlay(); act() } }
            }
            top.addView(v, LinearLayout.LayoutParams(dp(47), dp(47)))
            top.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        }
        topBtn("back", "后退", t?.canBack == true, pal.surf3, pal.on, 24) { t?.session?.goBack() }
        topBtn("fwd", "前进", t?.canFwd == true, pal.surf3, pal.on, 24) { t?.session?.goForward() }
        topBtn(if (marked) "star" else "starO", if (marked) "取消书签" else "添加书签", web, if (pal.dark) Color.parseColor("#3a3f55") else pal.tonal, pal.on, 16) { toggleBookmark(t!!) }
        topBtn("dl", "下载（暂不支持）", false, pal.surf3, pal.on, 24) {}
        topBtn("refresh", "刷新", t != null, if (pal.dark) Color.parseColor("#121318") else Color.parseColor("#1f1f1f"), Color.WHITE, 24) { t?.session?.reload() }
        top.removeViewAt(top.childCount - 1)
        box.addView(top)
        fun item(ic: String, label: String, trail: View? = null, enabled: Boolean = true, act: () -> Unit) = box.addView(menuRow(pal, ic, label, trail, enabled, 52) { closeOverlay(); act() })
        item("addBox", "打开新的标签页") { Core.openTab(Host.current) }
        box.addView(divider(pal))
        item("history", "历史记录") { openSheet("history", true) }
        item("del", "删除浏览数据") { clearData() }
        box.addView(divider(pal))
        item("dlDone", "下载内容", enabled = false) { toast("暂不支持下载文件") }
        item("starO", "书签") { openSheet("bookmarks", true) }
        item("devices", "最近打开的标签页") { recentClosed() }
        box.addView(divider(pal))
        item("tools", "更多工具") { moreTools(t) }
        item("gear", "设置") { openSheet("settings", true) }
        item("help", "帮助和反馈") { Core.openTab(Host.current, "https://github.com/halou367/masktab/issues") }
        val scroll = ScrollView(this).apply { addView(box); isVerticalScrollBarEnabled = false }
        val card = FrameLayout(this).apply { background = rounded(pal.surf, dp(26).toFloat()); elevation = dp(8).toFloat(); isClickable = true; addView(scroll) }
        overlayFit = { (card.layoutParams as? FrameLayout.LayoutParams)?.let { it.topMargin = inTop + dp(8); it.bottomMargin = inBottom + dp(16) }; card.requestLayout() }
        o.addView(card, FrameLayout.LayoutParams(minOf(dp(318), resources.displayMetrics.widthPixels - inLeft - inRight - dp(24)), -2, Gravity.TOP or Gravity.END).apply { rightMargin = dp(7) })
        fitOverlay(o)
        card.pivotX = card.layoutParams.width.toFloat(); card.pivotY = 0f
        card.scaleX = 0.85f; card.scaleY = 0.85f
        card.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
        logi("三点菜单已打开")
    }

    private fun toggleBookmark(t: Tab) {
        val l = Host.bookmarks.toMutableList()
        val had = l.any { it.second == t.url }
        if (had) l.removeAll { it.second == t.url } else l.add(t.title.ifEmpty { t.url } to t.url)
        bg {
            try {
                CoreProc.json("PATCH", "/api/settings", jsonOf("bookmarks" to JSONArray(l.map { jsonOf("title" to it.first, "url" to it.second) })))
                Host.refresh()
                toast(if (had) "已取消书签" else "已加到书签（新标签页上能看到）")
            } catch (e: Exception) { toast("书签没存上：${e.message}") }
        }
    }

    /** 删除浏览数据：清掉当前实例的 Cookie、网站数据和缓存，以及它的最近访问。先确认。 */
    private fun clearData() {
        val me = Host.cur() ?: return
        Theme.dialog(this).setTitle("删除浏览数据？")
            .setMessage("清除 #${me.no} 的 Cookie、网站数据、缓存和访问记录。登录状态会丢，记住的账号密码不受影响。其它实例不受影响。")
            .setPositiveButton("删除") { _, _ ->
                Core.runtime?.storageController?.clearDataForSessionContext(me.contextId)
                Recent.clear(me.id)
                Core.reloadInst(me.id)
                toast("已删除 #${me.no} 的浏览数据")
            }
            .setNegativeButton("取消", null).show()
    }

    private fun recentClosed() {
        val l = Core.closed.toList()
        if (l.isEmpty()) { toast("没有最近关闭的标签页"); return }
        Theme.dialog(this).setTitle("最近关闭的标签页")
            .setItems(l.map { (i, u) -> "#${Host.get(i)?.no ?: "?"}  ${u.removePrefix("https://").removePrefix("http://")}" }.toTypedArray()) { _, k ->
                val (i, u) = l[k]
                Core.closed.remove(l[k])
                if (Host.get(i) != null) { Core.switchTo(i); Core.openTab(i, u) }
            }.setNegativeButton("关闭", null).show()
    }

    private fun moreTools(t: Tab?) {
        val web = t != null && t.url.startsWith("http")
        val items = listOfNotNull(if (web) "复制链接" else null, if (web) "分享" else null, "诊断信息（${Diag.version(this)}）")
        Theme.dialog(this).setTitle("更多工具").setItems(items.toTypedArray()) { _, k ->
            when (items[k]) {
                "复制链接" -> { (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("链接", t!!.url)); toast("已复制链接") }
                "分享" -> try { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, t!!.url), "分享")) } catch (e: Exception) { toast("没有可用的应用") }
                else -> showDiag()
            }
        }.show()
    }

    /** 标签页切换器（照已确认演示 05）：顶栏下面一排实例头像（点一个看它的标签页），下面两列标签页卡片。 */
    private var tabsInst = ""
    private fun showTabs() {
        if (!Core.started) return
        closeSheet()
        tabsInst = Host.current
        // 先截当前网页做缩略图（异步，回来了再画一次）
        Core.curTab()?.let { t -> try { gecko.capturePixels().accept({ b -> if (b != null) { t.thumb = Bitmap.createScaledBitmap(b, maxOf(1, b.width / 3), maxOf(1, b.height / 3), true); b.recycle(); (overlay?.tag == "tabs").let { if (it) fillTabs() } } }, { _ -> }) } catch (e: Exception) { } }
        val o = newOverlay(false)
        o.tag = "tabs"
        overlayFit = { fillTabs() }
        o.setBackgroundColor(pal.bg)
        o.isClickable = true; o.setOnClickListener(null)
        fillTabs()
        logi("标签页切换器已打开")
    }

    private fun fillTabs() {
        val o = overlay ?: return
        if (o.tag != "tabs") return
        o.removeAllViews()
        val inst = Host.get(tabsInst) ?: Host.cur() ?: return
        val colm = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(inLeft, inTop, inRight, 0) }
        // 顶栏（照定稿的演示，决策 UI-10）：左边“+”开新标签页，标题，右边三点（关闭全部）
        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), 0, dp(4), 0) }
        top.addView(ImageView(this).apply {
            setImageDrawable(mi("add", pal.ontonal)); scaleType = ImageView.ScaleType.CENTER; background = rounded(pal.tonal, dp(16).toFloat()); contentDescription = "新标签页"; ripple(true)
            setOnClickListener { closeOverlay(); if (inst.id != Host.current) Core.switchTo(inst.id); Core.openTab(inst.id) }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        top.addView(text("标签页", 20f, pal.on).apply { setPadding(dp(16), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
        top.addView(btn(DotsView(this).apply { tint = pal.on }, "更多") {
            Theme.dialog(this).setItems(arrayOf("关闭 #${inst.no} 的全部标签页")) { _, _ -> closeOverlay(); Core.stopInst(inst.id) }.show()
        }, LinearLayout.LayoutParams(dp(44), dp(48)))
        colm.addView(top, LinearLayout.LayoutParams(-1, dp(64)))
        // 一排实例
        val strip = LinearLayout(this).apply { setPadding(dp(16), dp(10), dp(16), dp(6)) }
        for (x in Host.insts) {
            val on = x.id == inst.id
            strip.addView(LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), 0, dp(14), 0)
                background = rounded(if (on) pal.tonal else Color.TRANSPARENT, dp(20).toFloat(), if (on) 0 else dp(1), pal.div)
                addView(avatarOf(x, 32, if (on) pal.tonal else pal.bg).apply { dot = 0 })
                addView(text("#${x.no}", 14f, if (on) pal.ontonal else pal.on2, true).apply { setPadding(dp(8), 0, dp(6), 0) })
                val n = Core.tabsOf(x.id).size
                if (n > 0) addView(text(n.toString(), 13f, if (on) pal.ontonal else pal.on3))
                contentDescription = "实例 #${x.no}"
                ripple()
                setOnClickListener { tabsInst = x.id; fillTabs() }
            }, LinearLayout.LayoutParams(-2, dp(40)).apply { rightMargin = dp(8) })
        }
        colm.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(strip) })
        // 两列卡片
        val grid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(8), dp(14), inBottom + dp(24)) }
        val tabs = Core.tabsOf(inst.id)
        if (tabs.isEmpty()) grid.addView(text(if (inst.running) "#${inst.no} 还没有标签页，点左上角的 + 开一个" else "#${inst.no} 在休眠，点 + 打开它", 14f, pal.on3).apply { gravity = Gravity.CENTER; setPadding(0, dp(40), 0, 0); setSingleLine(false) })
        var row: LinearLayout? = null
        val cur = Core.active[inst.id]
        for ((k, t) in tabs.withIndex()) {
            if (k % 2 == 0) { row = LinearLayout(this); grid.addView(row, LinearLayout.LayoutParams(-1, dp(236)).apply { bottomMargin = dp(16) }) }
            val sel = t === cur && inst.id == Host.current
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(if (sel) pal.tonal else pal.surf2, dp(20).toFloat()); clipToOutline = true }
            val hd = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(14), 0, 0, 0) }
            val internal = isNtp(t) || Core.isInternal(t.url)
            val title = if (internal) "新标签页" else t.title.ifEmpty { t.url }
            hd.addView(TextView(this).apply {
                text = (title.firstOrNull { it.isLetterOrDigit() } ?: '·').uppercase(); textSize = 11f; setTextColor(Color.WHITE); gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD
                background = rounded(parseColor(inst.color), dp(11).toFloat())
            }, LinearLayout.LayoutParams(dp(22), dp(22)))
            hd.addView(text(title, 15f, if (sel) pal.ontonal else pal.on).apply { setPadding(dp(10), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
            hd.addView(ImageView(this).apply { setImageDrawable(mi("close", if (sel) pal.ontonal else pal.on2)); scaleType = ImageView.ScaleType.CENTER; contentDescription = "关闭标签页"; ripple(true)
                setOnClickListener { Core.closeTab(t); if (Core.tabsOf(inst.id).isEmpty() && inst.id == Host.current) closeOverlay() else fillTabs() } }, LinearLayout.LayoutParams(dp(44), dp(44)))
            card.addView(hd, LinearLayout.LayoutParams(-1, dp(48)))
            val th = FrameLayout(this).apply { background = rounded(if (pal.dark) pal.surf3 else Color.WHITE, dp(16).toFloat()); clipToOutline = true }
            t.thumb?.let { b -> th.addView(ImageView(this).apply { setImageBitmap(b); scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1)) }
                ?: th.addView(text(if (internal) "" else t.url.substringAfter("://").substringBefore('/'), 12f, pal.on3).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
            card.addView(th, LinearLayout.LayoutParams(-1, 0, 1f).apply { setMargins(dp(5), 0, dp(5), dp(5)) })
            card.contentDescription = "标签页 $title"
            card.ripple()
            card.setOnClickListener { closeOverlay(); if (inst.id != Host.current) Core.switchTo(inst.id); Core.selectTab(t) }
            row!!.addView(card, LinearLayout.LayoutParams(0, -1, 1f).apply { if (k % 2 == 0) rightMargin = dp(8) else leftMargin = dp(8) })
        }
        if (tabs.size % 2 == 1) row?.addView(View(this), LinearLayout.LayoutParams(0, -1, 1f).apply { leftMargin = dp(8) })
        colm.addView(ScrollView(this).apply { addView(grid); isVerticalScrollBarEnabled = false }, LinearLayout.LayoutParams(-1, 0, 1f))
        o.addView(colm, FrameLayout.LayoutParams(-1, -1))
    }

    // ---------- 诊断信息（原生窗口，不依赖内置页面：白屏、卡在启动页时也能用） ----------

    private fun showDiag() {
        val tv = TextView(this).apply {
            text = "正在收集…"; textSize = 11f; typeface = Typeface.MONOSPACE; setTextColor(pal.on)
            setTextIsSelectable(true); setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        var text = ""
        val d = Theme.dialog(this)
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
            Theme.dialog(this)
                .setTitle("上次没有正常退出")
                .setMessage("$why\n\n把诊断信息复制发给开发者，可以定位原因。以后也可以长按右上角头像、或点 ⋮ → 更多工具 → 诊断信息 打开。")
                .setPositiveButton("看诊断信息") { _, _ -> showDiag() }
                .setNegativeButton("不用", null)
                .show()
        } catch (e: Exception) { logw("提示窗口打不开", e) }
    }

    /** 用户扩展的弹窗。 */
    override fun showPopup(session: GeckoSession) {
        val d = Dialog(this, if (pal.dark) android.R.style.Theme_DeviceDefault_Dialog_NoActionBar else android.R.style.Theme_DeviceDefault_Light_Dialog_NoActionBar)
        val v = GeckoView(this)
        mainHandler.post { if (!session.isOpen) session.open(Core.ensureRuntime()); v.setSession(session) }
        d.setContentView(v, ViewGroup.LayoutParams(-1, -1))
        d.window?.setLayout(-1, (resources.displayMetrics.heightPixels * 0.7f).toInt())
        session.contentDelegate = object : GeckoSession.ContentDelegate { override fun onCloseRequest(s: GeckoSession) { d.dismiss() } }
        d.setOnDismissListener { v.releaseSession(); session.close() }
        d.show()
    }

    /** 返回：先关浮层，再交给内置页面（它按自己的返回栈退，栈空了自己收起），再网页后退，再关多余的标签，最后退到后台（不结束进程，后台实例保持）。 */
    private fun handleBack() {
        if (overlay != null) { closeOverlay(); return }
        if (panelOn) {
            val p = panel
            if (p != null && p.isOpen) p.loadUri(Core.pageUrl("__back")) else closeSheet()
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

/** 国家代码 → 中文名（头像菜单里用；和共用页面 ui.js 的表是同一份的子集，没列到的写代码）。 */
private val CN = mapOf("US" to "美国", "CA" to "加拿大", "GB" to "英国", "DE" to "德国", "FR" to "法国", "NL" to "荷兰", "JP" to "日本", "KR" to "韩国", "SG" to "新加坡",
    "HK" to "香港", "TW" to "台湾", "CN" to "中国", "AU" to "澳大利亚", "IN" to "印度", "RU" to "俄罗斯", "TR" to "土耳其", "VN" to "越南", "TH" to "泰国", "MY" to "马来西亚",
    "ID" to "印度尼西亚", "PH" to "菲律宾", "BR" to "巴西", "MX" to "墨西哥", "IT" to "意大利", "ES" to "西班牙", "SE" to "瑞典", "CH" to "瑞士", "PL" to "波兰", "AE" to "阿联酋", "IL" to "以色列")
fun cname(c: String) = if (c.isEmpty()) "未知" else CN[c.uppercase()] ?: c.uppercase()
