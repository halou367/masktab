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
import android.view.Gravity
import android.view.View
import android.view.animation.LinearInterpolator
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

/** 头像：当前实例的彩色圆点 + 编号，右下角出口国旗。 */
class AvatarView(ctx: Context) : View(ctx) {
    var color = Color.GRAY
    var label = "1"
    var flag: Bitmap? = null
    var busy = false
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }

    fun set(color: Int, label: String, flag: Bitmap?) { this.color = color; this.label = label; this.flag = flag; invalidate() }

    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val cx = width / 2f
        val cy = height / 2f
        val r = s * 0.34f
        p.style = Paint.Style.FILL
        p.color = color
        c.drawCircle(cx, cy, r, p)
        tp.textSize = r * (if (label.length > 2) 0.8f else 1.0f)
        c.drawText(label, cx, cy - (tp.descent() + tp.ascent()) / 2, tp)
        flag?.let {
            val fw = r * 1.0f
            val fh = fw * 0.7f
            val dst = RectF(cx + r * 0.35f, cy + r * 0.45f, cx + r * 0.35f + fw, cy + r * 0.45f + fh)
            p.color = Color.WHITE
            c.drawRoundRect(RectF(dst.left - 2, dst.top - 2, dst.right + 2, dst.bottom + 2), 4f, 4f, p)
            c.drawBitmap(it, null, dst, null)
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
class MaskLogo(ctx: Context) : View(ctx) {
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
        p.color = Color.parseColor("#1A73E8")
        p.alpha = (40 + 50 * phase).toInt()
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
        p.color = Color.WHITE
        c.drawPath(m, p)
        p.color = Color.parseColor("#1A73E8")
        c.drawCircle(X(8.5f), oy + 11 * u, 1.3f * u, p)
        c.drawCircle(X(15.5f), oy + 11 * u, 1.3f * u, p)
    }
}

/** 步骤状态图标：等待（灰圈）、进行中（转圈）、完成（勾）、跳过（横线）、失败（叉）。 */
class StepIcon(ctx: Context) : View(ctx) {
    var state = 0 // 0 等待 1 进行中 2 完成 3 跳过 4 失败
        set(v) { field = v; if (v == 1) spin.start() else spin.cancel(); invalidate() }
    private var angle = 0f
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val spin = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 900; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
        addUpdateListener { angle = it.animatedValue as Float; invalidate() }
    }
    override fun onDetachedFromWindow() { spin.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(c: Canvas) {
        val s = minOf(width, height).toFloat()
        val r = s * 0.38f
        val cx = width / 2f
        val cy = height / 2f
        p.strokeWidth = s * 0.09f
        when (state) {
            0 -> { p.color = Color.parseColor("#DADCE0"); c.drawCircle(cx, cy, r, p) }
            1 -> { p.color = Color.parseColor("#D2E3FC"); c.drawCircle(cx, cy, r, p); p.color = Color.parseColor("#1A73E8"); c.drawArc(RectF(cx - r, cy - r, cx + r, cy + r), angle, 100f, false, p) }
            2 -> {
                p.style = Paint.Style.FILL; p.color = Color.parseColor("#188038"); c.drawCircle(cx, cy, r + p.strokeWidth / 2, p)
                p.style = Paint.Style.STROKE; p.color = Color.WHITE
                val path = Path().apply { moveTo(cx - r * 0.45f, cy); lineTo(cx - r * 0.1f, cy + r * 0.35f); lineTo(cx + r * 0.5f, cy - r * 0.35f) }
                c.drawPath(path, p)
            }
            3 -> { p.color = Color.parseColor("#9AA0A6"); c.drawCircle(cx, cy, r, p); c.drawLine(cx - r * 0.45f, cy, cx + r * 0.45f, cy, p) }
            else -> {
                p.style = Paint.Style.FILL; p.color = Color.parseColor("#D93025"); c.drawCircle(cx, cy, r + p.strokeWidth / 2, p)
                p.style = Paint.Style.STROKE; p.color = Color.WHITE
                val d = r * 0.4f
                c.drawLine(cx - d, cy - d, cx + d, cy + d, p); c.drawLine(cx + d, cy - d, cx - d, cy + d, p)
            }
        }
    }
}

/** 启动进度页：标志 + 步骤列表（每步一个状态图标、名称、结果说明）。 */
class StartupView(ctx: Context, steps: List<String>) : LinearLayout(ctx) {
    private val icons = mutableListOf<StepIcon>()
    private val details = mutableListOf<TextView>()

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setBackgroundColor(Color.WHITE)
        isClickable = true
        setPadding(ctx.dp(32), ctx.dp(96), ctx.dp(32), ctx.dp(32))
        addView(MaskLogo(ctx), LayoutParams(ctx.dp(96), ctx.dp(96)))
        addView(TextView(ctx).apply {
            text = "MaskTab"; textSize = 22f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.parseColor("#202124"))
            gravity = Gravity.CENTER; setPadding(0, ctx.dp(12), 0, ctx.dp(28))
        })
        for (s in steps) {
            val row = LinearLayout(ctx).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, ctx.dp(7), 0, ctx.dp(7)) }
            val ic = StepIcon(ctx)
            row.addView(ic, LayoutParams(ctx.dp(22), ctx.dp(22)))
            val col = LinearLayout(ctx).apply { orientation = VERTICAL; setPadding(ctx.dp(14), 0, 0, 0) }
            col.addView(TextView(ctx).apply { text = s; textSize = 15f; setTextColor(Color.parseColor("#202124")) })
            val d = TextView(ctx).apply { textSize = 12f; setTextColor(Color.parseColor("#5F6368")); visibility = GONE }
            col.addView(d)
            row.addView(col, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
            addView(row, LayoutParams(ctx.dp(260), LayoutParams.WRAP_CONTENT))
            icons.add(ic); details.add(d)
        }
    }

    fun set(k: Int, state: Int, detail: String = "") {
        if (k !in icons.indices) return
        icons[k].state = state
        details[k].text = detail
        details[k].visibility = if (detail.isEmpty()) GONE else VISIBLE
    }
}
