package com.masktab.browser

import android.animation.ValueAnimator
import android.app.AlertDialog
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.PanZoomController

// 浏览器外壳的 Chrome 风格部件（决策 UI-1、UI-2、UI-4）：配色、图标、状态栏 / 导航栏底色、浮层（头像菜单、三点菜单、标签页切换器用）、下拉刷新。
// 只管样子和手势，不碰业务：数据都来自核心服务的状态（Host），动作都是核心服务的接口或内置页面的路由。

/** 配色：底色、文字色是固定的（深色取自需求方手机 Chrome 截图）；强调色、选中底色、各层卡片的底色跟着当前实例的颜色走（决策 UI-10，见 Theme.of）。 */
class Pal(
    val bg: Int, val pill: Int, val surf: Int, val surf2: Int, val surf3: Int, val div: Int,
    val on: Int, val on2: Int, val on3: Int, val acc: Int, val onacc: Int, val tonal: Int, val ontonal: Int,
    val good: Int, val mid: Int, val bad: Int, val scrim: Int, val dark: Boolean,
)

object Theme {
    private fun c(s: String) = Color.parseColor(s)
    val DARK = Pal(c("#0d0e13"), c("#31333f"), c("#292c33"), c("#18191e"), c("#1e1f24"), c("#45454d"),
        c("#e2e2ea"), c("#c5c5cd"), c("#9a9ba4"), c("#bdc5ea"), c("#2c3557"), c("#384160"), c("#dde1ff"),
        c("#81c995"), c("#fdd663"), c("#f28b82"), Color.argb(140, 0, 0, 0), true)
    val LIGHT = Pal(c("#ffffff"), c("#eceef4"), c("#f0f2f8"), c("#f3f5fa"), c("#e4e7ef"), c("#c8cad2"),
        c("#1b1b1f"), c("#44474e"), c("#6b6e76"), c("#0b57d0"), c("#ffffff"), c("#d3e3fd"), c("#041e49"),
        c("#188038"), c("#b26a00"), c("#d93025"), Color.argb(82, 0, 0, 0), false)

    /** 设置里的“外观”：system（默认，跟随系统的深浅色）| dark | light。 */
    fun isDark(ctx: Context): Boolean = when (Host.theme) {
        "light" -> false
        "dark" -> true
        else -> (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }
    fun pal(ctx: Context, seed: Int? = null) = of(isDark(ctx), seed ?: Color.parseColor("#1a73e8"))

    private fun hsl(h: Float, s: Float, l: Float): Int {
        val ss = s / 100f; val ll = l / 100f
        val a = ss * minOf(ll, 1f - ll)
        fun f(n: Int): Int { val k = (n + h / 30f) % 12f; return Math.round(255f * (ll - a * maxOf(-1f, minOf(k - 3f, 9f - k, 1f)))).coerceIn(0, 255) }
        return Color.rgb(f(0), f(8), f(4))
    }
    /**
     * 按“深 / 浅 + 实例色”算出一套颜色（决策 UI-10）。和共用页面 ui.js 的 accentTokens 是同一组公式，改一边要改另一边：
     * 页面里的底部表单和这里涂的导航栏用的是同一个 surf，两边算得不一样就会对不上。
     */
    fun of(dark: Boolean, seed: Int): Pal {
        val r = Color.red(seed) / 255f; val g = Color.green(seed) / 255f; val b = Color.blue(seed) / 255f
        val mx = maxOf(r, g, b); val mn = minOf(r, g, b); val d = mx - mn; val l = (mx + mn) / 2f
        var hh = 0f
        if (d > 0f) hh = if (mx == r) ((g - b) / d) % 6f else if (mx == g) (b - r) / d + 2f else (r - g) / d + 4f
        val hue = ((Math.round(hh * 60f) + 360) % 360).toFloat()
        val s0 = if (d > 0f) d / (1f - Math.abs(2f * l - 1f)) * 100f else 0f
        val s = minOf(s0, 90f); val n = minOf(s, 40f) / 40f
        fun c(sat: Float, li: Float) = hsl(hue, Math.round(sat).toFloat(), li)
        val k = if (dark) DARK else LIGHT
        return if (dark) Pal(k.bg, c(10f * n, 20f), c(10f * n, 17f), c(9f * n, 12.5f), c(9f * n, 19f), c(8f * n, 26f),
            k.on, k.on2, k.on3, c(s * 0.85f, 82f), c(s * 0.7f, 18f), c(s * 0.42f, 28f), c(s * 0.9f, 91f), k.good, k.mid, k.bad, k.scrim, true)
        else Pal(k.bg, c(28f * n, 92f), c(30f * n, 97f), c(30f * n, 95.5f), c(26f * n, 91f), c(16f * n, 84f),
            k.on, k.on2, k.on3, c(s * 0.9f, 40f), Color.WHITE, c(s * 0.9f, 90f), c(s * 0.8f, 20f), k.good, k.mid, k.bad, k.scrim, false)
    }

    /** 把半透明的 [top] 盖在 [base] 上之后的颜色（遮罩压暗状态栏用）。 */
    fun over(base: Int, top: Int): Int {
        val a = Color.alpha(top) / 255f
        fun ch(b: Int, t: Int) = (b * (1 - a) + t * a).toInt().coerceIn(0, 255)
        return Color.rgb(ch(Color.red(base), Color.red(top)), ch(Color.green(base), Color.green(top)), ch(Color.blue(base), Color.blue(top)))
    }
    /** 亮色底：状态栏 / 导航栏的图标要用深色。 */
    fun isLight(c: Int) = (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) > 150

    /** 系统对话框（诊断信息、确认）跟着主题。 */
    fun dialog(ctx: Context): AlertDialog.Builder =
        AlertDialog.Builder(ctx, if (isDark(ctx)) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
}

/** Material 图标（res/drawable/mi_*.xml，和共用页面 ui.js 里是同一份路径）。按名字取，免得外壳代码依赖生成的 R 类。 */
fun Context.mi(name: String, color: Int): Drawable? {
    val id = resources.getIdentifier("mi_" + name.lowercase(), "drawable", packageName)
    if (id == 0) { logw("缺少图标 $name"); return null }
    return getDrawable(id)?.mutate()?.apply { setTint(color) }
}

fun Context.icon(name: String, color: Int, size: Int = 24): ImageView = ImageView(this).apply {
    setImageDrawable(mi(name, color))
    scaleType = ImageView.ScaleType.CENTER
    minimumWidth = dp(size); minimumHeight = dp(size)
}

/** 点按反馈：系统的水波纹（无边界 = 圆形按钮）。 */
fun View.ripple(borderless: Boolean = false) {
    val a = context.obtainStyledAttributes(intArrayOf(if (borderless) android.R.attr.selectableItemBackgroundBorderless else android.R.attr.selectableItemBackground))
    foreground = a.getDrawable(0)
    a.recycle()
    isClickable = true
}

fun Context.text(s: CharSequence, sizeSp: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
    text = s; textSize = sizeSp; setTextColor(color)
    if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    setSingleLine(); ellipsize = TextUtils.TruncateAt.END
}

/**
 * 根布局：内容贴着系统给的 insets 摆（状态栏、刘海、导航栏 / 手势条、键盘），四周露出来的那一圈由这里涂色，
 * 颜色跟着当前页面和主题走（决策 UI-4）。安卓 15 起强制全屏绘制，系统不再给状态栏、导航栏涂底色，以前顶部和底部偶尔对不上就是这里没涂。
 */
class BarsLayout(ctx: Context) : FrameLayout(ctx) {
    var topColor = Color.BLACK
    var bottomColor = Color.BLACK
    var insetTop = 0; var insetBottom = 0; var insetLeft = 0; var insetRight = 0
    private val p = Paint()
    init { setWillNotDraw(false) }
    fun paint(top: Int, bottom: Int) { if (top != topColor || bottom != bottomColor) { topColor = top; bottomColor = bottom; invalidate() } }
    override fun onDraw(c: Canvas) {
        p.color = bottomColor
        c.drawRect(0f, 0f, width.toFloat(), height.toFloat(), p) // 两侧（横屏的刘海、三键导航）和底部
        p.color = topColor
        c.drawRect(0f, 0f, width.toFloat(), insetTop.toFloat(), p)
    }
}

/** 圆环（纯净度、伪装度）：0–100，越满越好；null = 不知道（灰色空环）。 */
class RingView(ctx: Context, private val pal: Pal) : View(ctx) {
    var value: Int? = null
        set(v) { field = v; invalidate() }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }
    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val w = s * 0.11f
        val r = RectF(w / 2 + (width - s) / 2, w / 2 + (height - s) / 2, (width + s) / 2 - w / 2, (height + s) / 2 - w / 2)
        val v = value
        val col = if (v == null) pal.on3 else if (v >= 80) pal.good else if (v >= 50) pal.mid else pal.bad
        p.strokeWidth = w
        p.color = col; p.alpha = 46
        c.drawArc(r, 0f, 360f, false, p)
        p.alpha = 255
        if (v != null) c.drawArc(r, -90f, 360f * v.coerceIn(0, 100) / 100f, false, p)
        tp.color = col; tp.textSize = s * 0.34f
        c.drawText(v?.toString() ?: "—", width / 2f, height / 2f - (tp.descent() + tp.ascent()) / 2, tp)
    }
}

/** 色点（CF 信誉）。 */
class DotView(ctx: Context, private val color: Int) : View(ctx) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) { p.color = color; c.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, p) }
}

/**
 * 浮层：盖住整个窗口（连状态栏、导航栏一起，所以遮罩压暗时两条栏一起变暗，不会对不上）。
 * [dim] = 压暗；点遮罩关闭。内容放在 [box] 里，由调用方决定摆在哪（底部表单 / 右上角菜单 / 全屏）。
 */
class Overlay(ctx: Context, val pal: Pal, dim: Boolean, val onClose: () -> Unit) : FrameLayout(ctx) {
    var closing = false
    init {
        setBackgroundColor(if (dim) pal.scrim else Color.TRANSPARENT)
        isClickable = true
        setOnClickListener { close() }
        alpha = 0f
        animate().alpha(1f).setDuration(160).start()
    }
    fun close() {
        if (closing) return
        closing = true
        animate().alpha(0f).setDuration(140).withEndAction { (parent as? ViewGroup)?.removeView(this); onClose() }.start()
    }
}

/** 一行（头像菜单、三点菜单里的项）：图标、文字、右边的小字或控件。 */
fun Context.menuRow(pal: Pal, ic: String?, label: String, trail: View? = null, enabled: Boolean = true, h: Int = 56, onClick: () -> Unit): LinearLayout =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(h)
        setPadding(dp(24), 0, dp(20), 0)
        val c = if (enabled) pal.on else pal.on3
        if (ic != null) addView(icon(ic, if (enabled) pal.on2 else pal.on3), LinearLayout.LayoutParams(dp(24), dp(24)).apply { rightMargin = dp(20) })
        addView(text(label, 16f, c), LinearLayout.LayoutParams(0, -2, 1f))
        if (trail != null) addView(trail)
        contentDescription = label
        ripple()
        setOnClickListener { onClick() }
    }

fun Context.divider(pal: Pal, inset: Int = 18): View = View(this).apply {
    setBackgroundColor(pal.div)
    layoutParams = LinearLayout.LayoutParams(-1, 1).apply { setMargins(dp(inset), dp(6), dp(inset), dp(6)) }
}

/**
 * GeckoView 加上“网页有没有吃掉这次触摸”的结果：按下时问 Gecko（APZ）这一下会怎么处理——
 * 网页自己处理了（preventDefault、里层可滚动的区域）、页面还能往上滚、或者 CSS 关了下拉（overscroll-behavior），都不能触发下拉刷新。
 */
class TouchGecko(ctx: Context) : GeckoView(ctx) {
    /** 这一次按下时 Gecko 的判断；null = 还没回来（不触发下拉刷新）。 */
    @Volatile var detail: PanZoomController.InputResultDetail? = null
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            detail = null
            val r = onTouchEventForDetailResult(event)
            r.accept({ d -> detail = d }, { _ -> })
            return true
        }
        return super.onTouchEvent(event)
    }
    /** 现在是不是“页面已经在最顶上、网页没接手、往下拉就是下拉刷新”。 */
    fun canPullDown(): Boolean {
        val d = detail ?: return false
        if (d.handledResult() == PanZoomController.INPUT_RESULT_HANDLED_CONTENT) return false
        if ((d.scrollableDirections() and PanZoomController.SCROLLABLE_FLAG_TOP) != 0) return false
        // 没人接手（INPUT_RESULT_UNHANDLED）：页面整个不能滚（短页面，如 example.com），网页也没 preventDefault。
        // 这时 Gecko 给的越界方向不一定可靠（可能是 0），所以直接算可以下拉，免得短页面永远拉不出刷新（决策 UI-5）。
        if (d.handledResult() == PanZoomController.INPUT_RESULT_UNHANDLED) return true
        return (d.overscrollDirections() and PanZoomController.OVERSCROLL_FLAG_VERTICAL) != 0
    }
}

/**
 * 下拉刷新（和官方 Chrome 一样）：页面滚到最顶、往下拉，顶上出现一个圆形指示器，拉过一定距离松手就刷新。
 * 只在 [enabled]（显示的是网页，不是内置页面 / 新标签页）、页面在顶部（[atTop]，来自 GeckoSession 的滚动回调）、
 * 并且 Gecko 说这一下没被网页自己接手（[TouchGecko.canPullDown]）时才拦截手势，所以不会和网页自己的滚动、拖动冲突。
 */
class PullRefresh(ctx: Context, val gecko: TouchGecko, private val pal: () -> Pal) : FrameLayout(ctx) {
    var enabled2 = false
    var atTop: () -> Boolean = { true }
    var onRefresh: () -> Unit = {}
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var downX = 0f; private var downY = 0f
    private var pulling = false
    private var dist = 0f
    private val trigger = ctx.dp(80).toFloat()
    private val maxPull = ctx.dp(140).toFloat()
    private val spinner = Spinner(ctx)
    var refreshing = false
        private set

    init {
        addView(gecko, LayoutParams(-1, -1))
        addView(spinner, LayoutParams(ctx.dp(40), ctx.dp(40), Gravity.TOP or Gravity.CENTER_HORIZONTAL))
        spinner.visibility = View.INVISIBLE
        spinner.elevation = ctx.dp(4).toFloat()
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        if (!enabled2 || refreshing) return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = ev.x; downY = ev.y; pulling = false }
            MotionEvent.ACTION_MOVE -> {
                val dy = ev.y - downY; val dx = ev.x - downX
                if (!pulling && dy > slop && dy > Math.abs(dx) * 1.5f && atTop() && gecko.canPullDown()) {
                    pulling = true; downY = ev.y; dist = 0f
                    spinner.show(pal())
                    return true // 网页这次收到 CANCEL，之后由这里接手
                }
            }
        }
        return false
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        if (!pulling) return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_MOVE -> { dist = ((ev.y - downY) * 0.55f).coerceIn(0f, maxPull); spinner.drag(dist, trigger) }
            MotionEvent.ACTION_UP -> { pulling = false; if (dist >= trigger) start() else spinner.hide() }
            MotionEvent.ACTION_CANCEL -> { pulling = false; spinner.hide() }
        }
        return true
    }

    private fun start() {
        refreshing = true
        spinner.spin(trigger * 0.75f)
        logi("下拉刷新")
        onRefresh()
        // 最多转 8 秒；页面加载完会更早调 [done]
        mainHandler.postDelayed({ done() }, 8000)
    }
    /** 页面加载完了（或切走了）：收起指示器。 */
    fun done() { if (!refreshing) return; refreshing = false; spinner.hide() }

    /** Chrome 那样的圆形指示器：拉的时候箭头弧线跟着长，松手后转圈。 */
    private class Spinner(ctx: Context) : View(ctx) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
        private val bgp = Paint(Paint.ANTI_ALIAS_FLAG)
        private var sweep = 0f; private var start = 0f; private var spinning = false
        private var fg = Color.BLUE; private var bgc = Color.WHITE
        private val anim = ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 900; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
            addUpdateListener { start = it.animatedValue as Float; invalidate() }
        }
        fun show(pal: Pal) { fg = pal.acc; bgc = pal.surf; visibility = VISIBLE; alpha = 1f; translationY = -height.toFloat(); spinning = false; sweep = 0f; invalidate() }
        fun drag(d: Float, trig: Float) { translationY = d - height; sweep = (d / trig).coerceAtMost(1f) * 280f; alpha = (0.4f + d / trig).coerceAtMost(1f); rotation = d; invalidate() }
        fun spin(at: Float) { animate().translationY(at - height * 0.2f).setDuration(150).start(); spinning = true; sweep = 270f; anim.start() }
        fun hide() { anim.cancel(); spinning = false; animate().translationY(-height.toFloat()).alpha(0f).setInterpolator(DecelerateInterpolator()).setDuration(220).withEndAction { visibility = INVISIBLE }.start() }
        override fun onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow() }
        override fun onDraw(c: Canvas) {
            val s = minOf(width, height).toFloat()
            bgp.color = bgc
            c.drawCircle(width / 2f, height / 2f, s / 2f, bgp)
            p.color = fg; p.strokeWidth = s * 0.08f
            val r = s * 0.27f
            val o = RectF(width / 2f - r, height / 2f - r, width / 2f + r, height / 2f + r)
            c.drawArc(o, if (spinning) start else -90f, maxOf(8f, sweep), false, p)
        }
    }
}
