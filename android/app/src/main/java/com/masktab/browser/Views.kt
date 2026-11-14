package com.masktab.browser

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

// 自绘的小控件：工具栏头像、标签数方块、菜单三点、启动进度页。界面以图标为主，文字少。

fun parseColor(s: String, def: Int = Color.parseColor("#1A73E8")): Int = try { Color.parseColor(s) } catch (e: Exception) { def }

fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
    if (stroke > 0) setStroke(stroke, strokeColor)
}

private val flagCache = HashMap<String, Bitmap?>()

/** 国旗图（复用桌面伴随扩展的 assets/flags，构建时合成进 assets/ext）。 */
fun flagBitmap(ctx: Context, cc: String?): Bitmap? {
    val c = cc?.lowercase()?.takeIf { it.length == 2 } ?: return null
    return flagCache.getOrPut(c) {
        try { ctx.assets.open("ext/assets/flags/$c.png").use { BitmapFactory.decodeStream(it) } } catch (e: Exception) { null }
    }
}

/** 头像：实例色圆 + 编号，右下角出口国旗，右上角运行点（Chrome 风格界面，决策 UI-1）。[ring] = 国旗和运行点的描边色（等于所在底色）。 */
class AvatarView(ctx: Context) : View(ctx) {
    var color = Color.GRAY
    var label = "1"
    var flag: Bitmap? = null
    var busy = false
    /** 0 不画 | 1 运行中（绿）| 2 启动中（强调色）| 3 休眠（灰） */
    var dot = 0
    var ring = Color.parseColor("#0d0e13")
    var dotColors = intArrayOf(Color.parseColor("#81c995"), Color.parseColor("#bdc5ea"), Color.parseColor("#9a9ba4"))
    /** 圆占控件短边的比例（工具栏上留点边，列表里撑满）。 */
    var scale = 0.68f
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }

    fun set(color: Int, label: String, flag: Bitmap?) { this.color = color; this.label = label; this.flag = flag; invalidate() }

    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val cx = width / 2f
        val cy = height / 2f
        val r = s * scale / 2f
        p.style = Paint.Style.FILL
        p.color = color
        c.drawCircle(cx, cy, r, p)
        tp.textSize = r * (if (label.length > 2) 0.62f else if (label.length > 1) 0.78f else 0.9f)
        c.drawText(label, cx, cy - (tp.descent() + tp.ascent()) / 2, tp)
        flag?.let {
            val fw = r * 1.0f
            val fh = fw * 0.74f
            val dst = RectF(cx + r * 0.48f, cy + r * 0.52f, cx + r * 0.48f + fw, cy + r * 0.52f + fh)
            p.color = ring
            val b = s * 0.03f
            c.drawRoundRect(RectF(dst.left - b, dst.top - b, dst.right + b, dst.bottom + b), b * 1.5f, b * 1.5f, p)
            c.drawBitmap(it, null, dst, null)
        }
        if (dot in 1..3) {
            val dr = r * 0.27f
            val dx = cx + r * 0.78f
            val dy = cy - r * 0.78f
            p.color = ring; c.drawCircle(dx, dy, dr + s * 0.03f, p)
            p.color = dotColors[dot - 1]; c.drawCircle(dx, dy, dr, p)
        }
    }
}

/** 标签数：Chrome 那样的圆角方框里写数字。 */
class TabCountView(ctx: Context) : View(ctx) {
    var count = 1
        set(v) { field = v; invalidate() }
    var tint = Color.parseColor("#3C4043")
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) {
        val s = minOf(width, height) * 0.42f
        val cx = width / 2f
        val cy = height / 2f
        p.style = Paint.Style.STROKE
        p.strokeWidth = s * 0.11f
        p.color = tint
        c.drawRoundRect(RectF(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2), s * 0.2f, s * 0.2f, p)
        p.style = Paint.Style.FILL
        p.textAlign = Paint.Align.CENTER
        p.typeface = Typeface.DEFAULT_BOLD
        val t = if (count > 99) ":D" else count.toString()
        p.textSize = s * (if (t.length > 1) 0.5f else 0.6f)
        c.drawText(t, cx, cy - (p.descent() + p.ascent()) / 2, p)
    }
}

/** 菜单三点。 */
class DotsView(ctx: Context) : View(ctx) {
    var tint = Color.parseColor("#3C4043")
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) {
        val r = minOf(width, height) * 0.045f
        p.color = tint
        for (k in -1..1) c.drawCircle(width / 2f, height / 2f + k * r * 3.4f, r, p)
    }
}

/** 启动页上的面具标志（缓慢呼吸）。 */
class MaskLogo(ctx: Context, private val fg: Int = Color.parseColor("#bdc5ea"), private val ink: Int = Color.parseColor("#2c3557")) : View(ctx) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private var phase = 0f
    private val anim = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1600; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE
        addUpdateListener { phase = it.animatedValue as Float; invalidate() }
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); anim.start() }
    override fun onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(c: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val s = minOf(w, h)
        p.style = Paint.Style.FILL
        p.color = fg
        p.alpha = (30 + 50 * phase).toInt()
        c.drawCircle(w / 2, h / 2, s * (0.42f + 0.06f * phase), p)
        p.alpha = 255
        c.drawCircle(w / 2, h / 2, s * 0.36f, p)
        // 面具轮廓
        val m = Path()
        val u = s * 0.36f / 12f
        val ox = w / 2 - 12 * u
        val oy = h / 2 - 12 * u
        fun X(v: Float) = ox + v * u
        m.moveTo(X(3f), oy + 8 * u); m.cubicTo(X(6f), oy + 6 * u, X(9f), oy + 6 * u, X(12f), oy + 8 * u)
        m.cubicTo(X(15f), oy + 6 * u, X(18f), oy + 6 * u, X(21f), oy + 8 * u)
        m.cubicTo(X(21f), oy + 13 * u, X(18f), oy + 17 * u, X(15f), oy + 17 * u)
        m.cubicTo(X(13.5f), oy + 17 * u, X(13f), oy + 15.5f * u, X(12f), oy + 15.5f * u)
        m.cubicTo(X(11f), oy + 15.5f * u, X(10.5f), oy + 17 * u, X(9f), oy + 17 * u)
        m.cubicTo(X(6f), oy + 17 * u, X(3f), oy + 13 * u, X(3f), oy + 8 * u)
        m.close()
        p.color = ink
        c.drawPath(m, p)
        p.color = fg
        c.drawCircle(X(8.5f), oy + 11 * u, 1.3f * u, p)
        c.drawCircle(X(15.5f), oy + 11 * u, 1.3f * u, p)
    }
}

/** 步骤状态图标：等待（小灰点）、进行中（转圈）、完成（绿勾）、跳过（横线）、失败（红叉）。 */
class StepIcon(ctx: Context, private val pal: Pal) : View(ctx) {
    var state = 0 // 0 等待 1 进行中 2 完成 3 跳过 4 失败
        set(v) { field = v; if (v == 1) spin.start() else spin.cancel(); invalidate() }
    private var angle = 0f
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val spin = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 800; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
        addUpdateListener { angle = it.animatedValue as Float; invalidate() }
    }
    override fun onDetachedFromWindow() { spin.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val r = s * 0.38f
        val cx = width / 2f
        val cy = height / 2f
        p.strokeWidth = s * 0.1f
        when (state) {
            0 -> { p.style = Paint.Style.FILL; p.color = pal.div; c.drawCircle(cx, cy, s * 0.17f, p); p.style = Paint.Style.STROKE }
            1 -> { p.color = pal.div; c.drawCircle(cx, cy, r, p); p.color = pal.acc; c.drawArc(RectF(cx - r, cy - r, cx + r, cy + r), angle, 100f, false, p) }
            2 -> {
                p.style = Paint.Style.FILL; p.color = pal.good; c.drawCircle(cx, cy, r + p.strokeWidth / 2, p)
                p.style = Paint.Style.STROKE; p.color = pal.bg
                val path = Path().apply { moveTo(cx - r * 0.45f, cy); lineTo(cx - r * 0.1f, cy + r * 0.35f); lineTo(cx + r * 0.5f, cy - r * 0.35f) }
                c.drawPath(path, p)
            }
            3 -> { p.color = pal.on3; c.drawCircle(cx, cy, r, p); c.drawLine(cx - r * 0.45f, cy, cx + r * 0.45f, cy, p) }
            else -> {
                p.style = Paint.Style.FILL; p.color = pal.bad; c.drawCircle(cx, cy, r + p.strokeWidth / 2, p)
                p.style = Paint.Style.STROKE; p.color = pal.bg
                val d = r * 0.4f
                c.drawLine(cx - d, cy - d, cx + d, cy + d, p); c.drawLine(cx + d, cy - d, cx - d, cy + d, p)
            }
        }
    }
}

/**
 * 启动核验页（照已确认的演示 13-boot）：标志呼吸、名称、每一步一行（状态图标、名称、右边的结果），底部一条进度条。
 * 最后一步“网络检测”开始时，标志换成当前实例的头像（实例色、编号、出口国旗）。
 */
class StartupView(ctx: Context, steps: List<String>, private val pal: Pal) : FrameLayout(ctx) {
    private val icons = mutableListOf<StepIcon>()
    private val details = mutableListOf<TextView>()
    private val names = mutableListOf<TextView>()
    private val logoBox = FrameLayout(ctx)
    private val sub: TextView
    private val prog = View(ctx)
    private val col = LinearLayout(ctx)
    val content: LinearLayout get() = col

    init {
        setBackgroundColor(pal.bg)
        isClickable = true
        col.orientation = LinearLayout.VERTICAL
        col.gravity = Gravity.CENTER_HORIZONTAL
        col.setPadding(ctx.dp(32), ctx.dp(112), ctx.dp(32), ctx.dp(32))
        logoBox.addView(MaskLogo(ctx, pal.acc, pal.onacc), LayoutParams(-1, -1))
        col.addView(logoBox, LinearLayout.LayoutParams(ctx.dp(96), ctx.dp(96)))
        col.addView(TextView(ctx).apply {
            text = "MaskTab"; textSize = 22f; setTextColor(pal.on); gravity = Gravity.CENTER; setPadding(0, ctx.dp(18), 0, 0)
        })
        sub = TextView(ctx).apply { text = "正在核验运行环境"; textSize = 14f; setTextColor(pal.on2); gravity = Gravity.CENTER; setPadding(0, ctx.dp(6), 0, ctx.dp(30)) }
        col.addView(sub)
        for (s in steps) {
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = ctx.dp(44) }
            val ic = StepIcon(ctx, pal)
            row.addView(ic, LinearLayout.LayoutParams(ctx.dp(24), ctx.dp(24)))
            val nm = TextView(ctx).apply { text = s; textSize = 15f; setTextColor(pal.on3); setPadding(ctx.dp(14), 0, ctx.dp(8), 0) }
            row.addView(nm, LinearLayout.LayoutParams(-2, -2))
            val d = TextView(ctx).apply { textSize = 13f; setTextColor(pal.on2); gravity = Gravity.END; setSingleLine(); ellipsize = TextUtils.TruncateAt.END }
            row.addView(d, LinearLayout.LayoutParams(0, -2, 1f))
            col.addView(row, LinearLayout.LayoutParams(ctx.dp(320).coerceAtMost(ctx.resources.displayMetrics.widthPixels - ctx.dp(48)), -2))
            icons.add(ic); details.add(d); names.add(nm)
        }
        addView(col, LayoutParams(-1, -1))
        prog.setBackgroundColor(pal.acc)
        addView(prog, LayoutParams(0, ctx.dp(3), Gravity.BOTTOM))
    }

    /** 底部留出导航栏的位置（insets 由外面给）。 */
    fun insets(top: Int, bottom: Int) { (prog.layoutParams as LayoutParams).bottomMargin = bottom; col.setPadding(col.paddingLeft, context.dp(96) + top, col.paddingRight, context.dp(24) + bottom); requestLayout() }

    fun set(k: Int, state: Int, detail: String = "") {
        if (k !in icons.indices) return
        icons[k].state = state
        details[k].text = detail
        names[k].setTextColor(if (state == 0) pal.on3 else pal.on)
        val done = icons.count { it.state >= 2 }
        prog.layoutParams = (prog.layoutParams as LayoutParams).apply { width = this@StartupView.width * done / icons.size.coerceAtLeast(1) }
        prog.requestLayout()
        if (state == 4) sub.text = "有一步没过，点底部的版本号看诊断信息"
    }

    /** 换成实例头像（网络检测那一步）。 */
    fun showInst(color: Int, no: String, flag: Bitmap?) {
        logoBox.removeAllViews()
        logoBox.addView(AvatarView(context).apply { set(color, no, flag); scale = 0.8f; ring = pal.bg }, LayoutParams(-1, -1))
        logoBox.scaleX = 0.5f; logoBox.scaleY = 0.5f
        logoBox.animate().scaleX(1f).scaleY(1f).setDuration(300).start()
        sub.text = "#$no 正在核验出口"
    }
}
