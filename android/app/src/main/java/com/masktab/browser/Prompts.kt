package com.masktab.browser

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.DialogInterface
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.EditText
import android.widget.LinearLayout
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession.PromptDelegate
import org.mozilla.geckoview.WebExtension

// 网页弹框（alert / confirm / prompt / <select> 下拉）、选择文件（上传）、日期 / 时间 / 颜色、网站要用户名密码、网页发起的分享，
// 以及安装扩展确认，用系统对话框实现。

private typealias DT = PromptDelegate.DateTimePrompt.Type

/**
 * @param pick 打开系统的文件选择界面，选完（或取消 = null）回调——由 Activity 提供（要用 startActivityForResult）。
 */
class Prompts(private val a: Activity, private val pick: (Intent, (List<Uri>?) -> Unit) -> Unit = { _, done -> done(null) }) {
    // 跟着“外观”设置的深浅色（以前固定是深色的）
    private fun dlg() = Theme.dialog(a)
    private fun pickerTheme() = if (Theme.isDark(a)) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert

    fun alert(p: PromptDelegate.AlertPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        dlg().setTitle(p.title).setMessage(p.message).setPositiveButton("确定", null)
            .setOnDismissListener { if (!p.isComplete) r.complete(p.dismiss()) }.show()
        return r
    }

    fun button(p: PromptDelegate.ButtonPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        var done = false
        dlg().setTitle(p.title).setMessage(p.message)
            .setPositiveButton("确定") { _, _ -> done = true; r.complete(p.confirm(PromptDelegate.ButtonPrompt.Type.POSITIVE)) }
            .setNegativeButton("取消") { _, _ -> done = true; r.complete(p.confirm(PromptDelegate.ButtonPrompt.Type.NEGATIVE)) }
            .setOnDismissListener { if (!done) r.complete(p.dismiss()) }.show()
        return r
    }

    fun text(p: PromptDelegate.TextPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        val e = EditText(a).apply { setText(p.defaultValue ?: ""); setSingleLine() }
        var done = false
        dlg().setTitle(p.title ?: p.message).setMessage(if (p.title != null) p.message else null).setView(e)
            .setPositiveButton("确定") { _, _ -> done = true; r.complete(p.confirm(e.text.toString())) }
            .setNegativeButton("取消") { _, _ -> done = true; r.complete(p.dismiss()) }
            .setOnDismissListener { if (!done) r.complete(p.dismiss()) }.show()
        return r
    }

    fun choice(p: PromptDelegate.ChoicePrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        // 分组（<optgroup>）展开成一层
        val flat = mutableListOf<PromptDelegate.ChoicePrompt.Choice>()
        fun walk(cs: Array<PromptDelegate.ChoicePrompt.Choice>) { for (c in cs) { if (c.items != null) walk(c.items!!) else if (!c.separator) flat.add(c) } }
        walk(p.choices)
        val labels = flat.map { it.label }.toTypedArray()
        var done = false
        val b = dlg().setTitle(p.title ?: p.message)
        if (p.type == PromptDelegate.ChoicePrompt.Type.MULTIPLE) {
            val checked = flat.map { it.selected }.toBooleanArray()
            b.setMultiChoiceItems(labels, checked) { _, k, v -> checked[k] = v }
                .setPositiveButton("确定") { _, _ -> done = true; r.complete(p.confirm(flat.filterIndexed { k, _ -> checked[k] }.map { it.id }.toTypedArray())) }
        } else {
            b.setSingleChoiceItems(labels, flat.indexOfFirst { it.selected }) { d, k ->
                if (!flat[k].disabled) { done = true; r.complete(p.confirm(flat[k])); d.dismiss() }
            }
        }
        b.setOnDismissListener { if (!done) r.complete(p.dismiss()) }.show()
        return r
    }

    /** <input type=file>：系统的文件选择界面。选出来的先抄到缓存目录（内核只认文件路径，见 [Uploads]）。 */
    fun file(p: PromptDelegate.FilePrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        if (p.type == PromptDelegate.FilePrompt.Type.FOLDER) {
            Core.ui?.toast("手机上不支持上传整个文件夹，请改选文件")
            r.complete(p.dismiss())
            return r
        }
        // 网页要的类型：可能是 image/*、application/pdf，也可能是 .pdf 这样的扩展名；有一个认不出来就不限类型
        var any = false
        val types = (p.mimeTypes ?: emptyArray()).mapNotNull { raw ->
            val m = (raw ?: "").trim().lowercase()
            when {
                m.isEmpty() -> null
                m.startsWith(".") -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(m.drop(1)) ?: run { any = true; null }
                m.contains('/') -> m
                else -> { any = true; null }
            }
        }.distinct()
        val i = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
        i.type = if (!any && types.size == 1) types[0] else "*/*"
        if (!any && types.size > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        val many = p.type == PromptDelegate.FilePrompt.Type.MULTIPLE
        if (many) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        logi("选择文件 类型 ${if (any || types.isEmpty()) "不限" else types.joinToString(",")}${if (many) " 可多选" else ""}")
        pick(i) { uris ->
            if (uris.isNullOrEmpty()) { r.complete(p.dismiss()); return@pick }
            bg {
                val files = (if (many) uris else uris.take(1)).mapNotNull { Uploads.copy(a, it) }
                ui {
                    try {
                        if (files.isEmpty()) { Core.ui?.toast("选的文件读不出来"); r.complete(p.dismiss()) }
                        else { logi("选了 ${files.size} 个文件"); r.complete(p.confirm(a, files.toTypedArray())) }
                    } catch (e: Exception) { logw("文件没交给网页", e); if (!p.isComplete) r.complete(p.dismiss()) }
                }
            }
        }
        return r
    }

    /** 网站（或代理）要用户名和密码（HTTP 认证）。 */
    fun auth(p: PromptDelegate.AuthPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        val o = p.authOptions
        val onlyPw = o.flags and PromptDelegate.AuthPrompt.AuthOptions.Flags.ONLY_PASSWORD != 0
        val user = EditText(a).apply { hint = "用户名"; setSingleLine(); setText(o.username ?: ""); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val pass = EditText(a).apply { hint = "密码"; setSingleLine(); setText(o.password ?: ""); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val box = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(a.dp(20), a.dp(4), a.dp(20), 0)
            if (!onlyPw) addView(user)
            addView(pass)
        }
        var done = false
        dlg().setTitle(p.title ?: "需要登录").setMessage(p.message).setView(box)
            .setPositiveButton("登录") { _, _ -> done = true; r.complete(if (onlyPw) p.confirm(pass.text.toString()) else p.confirm(user.text.toString(), pass.text.toString())) }
            .setNegativeButton("取消") { _, _ -> done = true; r.complete(p.dismiss()) }
            .setOnDismissListener { if (!done) r.complete(p.dismiss()) }.show()
        return r
    }

    /** <input type=date / time / datetime-local / month / week>：系统的日期、时间选择。 */
    fun dateTime(p: PromptDelegate.DateTimePrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        val pattern = when (p.type) {
            DT.DATE -> "yyyy-MM-dd"; DT.MONTH -> "yyyy-MM"; DT.WEEK -> "YYYY-'W'ww"; DT.TIME -> "HH:mm"; else -> "yyyy-MM-dd'T'HH:mm"
        }
        val cal = java.util.Calendar.getInstance()
        // 周按 ISO 的算法：周一开头，一年的第一周是含 1 月 4 日的那一周
        if (p.type == DT.WEEK) { cal.firstDayOfWeek = java.util.Calendar.MONDAY; cal.minimalDaysInFirstWeek = 4 }
        val fmt = java.text.SimpleDateFormat(pattern, java.util.Locale.US).apply { calendar = cal.clone() as java.util.Calendar }
        fun parse(v: String?): java.util.Date? = if (v.isNullOrEmpty()) null else try { fmt.parse(v) } catch (e: Exception) { null }
        parse(p.defaultValue)?.let { cal.time = it }
        var done = false
        fun finish(v: String?) { if (!done) { done = true; r.complete(if (v == null) p.dismiss() else p.confirm(v)) } }
        fun out() = finish(fmt.format(cal.time))
        fun askTime() {
            var set = false
            TimePickerDialog(a, pickerTheme(), { _, h, m -> set = true; cal.set(java.util.Calendar.HOUR_OF_DAY, h); cal.set(java.util.Calendar.MINUTE, m); out() },
                cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE), true).apply {
                setButton(DialogInterface.BUTTON_NEUTRAL, "清除") { _, _ -> set = true; finish("") }
                setOnDismissListener { if (!set) finish(null) }
            }.show()
        }
        if (p.type == DT.TIME) { askTime(); return r }
        var set = false
        DatePickerDialog(a, pickerTheme(), { _, y, mo, d ->
            set = true
            cal.set(y, mo, d)
            if (p.type == DT.DATETIME_LOCAL) askTime() else out()
        }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH)).apply {
            if (p.type == DT.DATE || p.type == DT.DATETIME_LOCAL) {
                parse(p.minValue)?.let { datePicker.minDate = it.time }
                parse(p.maxValue)?.let { datePicker.maxDate = it.time }
            }
            setButton(DialogInterface.BUTTON_NEUTRAL, "清除") { _, _ -> set = true; finish("") }
            setOnDismissListener { if (!set) finish(null) }
        }.show()
        return r
    }

    /** <input type=color>：一排常用颜色 + 手填 #rrggbb。 */
    fun color(p: PromptDelegate.ColorPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        var done = false
        val hex = EditText(a).apply { setSingleLine(); setText(p.defaultValue ?: "#000000"); hint = "#rrggbb" }
        val preset = (p.predefinedValues?.filterNotNull()?.takeIf { it.isNotEmpty() }
            ?: listOf("#000000", "#5f6368", "#ffffff", "#d93025", "#f29900", "#fbbc04", "#188038", "#12b5cb", "#1a73e8", "#8430ce", "#e52592", "#795548"))
        val box = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(a.dp(20), a.dp(8), a.dp(20), 0) }
        var d: AlertDialog? = null
        for (line in preset.take(18).chunked(6)) {
            val row = LinearLayout(a).apply { gravity = Gravity.CENTER_VERTICAL }
            for (c in line) {
                val v = View(a).apply {
                    background = rounded(try { Color.parseColor(c) } catch (e: Exception) { Color.BLACK }, a.dp(8).toFloat(), a.dp(1), Color.argb(90, 128, 128, 128))
                    contentDescription = "颜色 $c"
                    setOnClickListener { done = true; r.complete(p.confirm(c)); d?.dismiss() }
                }
                row.addView(v, LinearLayout.LayoutParams(a.dp(36), a.dp(36)).apply { rightMargin = a.dp(8); bottomMargin = a.dp(8) })
            }
            box.addView(row)
        }
        box.addView(hex)
        d = dlg().setTitle(p.title ?: "选择颜色").setView(box)
            .setPositiveButton("确定") { _, _ ->
                val v = hex.text.toString().trim().lowercase()
                done = true
                r.complete(if (Regex("#[0-9a-f]{6}").matches(v)) p.confirm(v) else p.dismiss())
            }
            .setNegativeButton("取消", null)
            .setOnDismissListener { if (!done) r.complete(p.dismiss()) }.show()
        return r
    }

    /** 网页调用 navigator.share：交给系统的分享面板。 */
    fun share(p: PromptDelegate.SharePrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val text = listOfNotNull(p.title, p.text, p.uri).filter { it.isNotEmpty() }.joinToString("\n")
        return try {
            a.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "分享"))
            GeckoResult.fromValue(p.confirm(PromptDelegate.SharePrompt.Result.SUCCESS))
        } catch (e: Exception) { GeckoResult.fromValue(p.confirm(PromptDelegate.SharePrompt.Result.FAILURE)) }
    }

    /** 刷新一个刚提交过表单的页面：问要不要再提交一遍。 */
    fun repost(p: PromptDelegate.RepostConfirmPrompt): GeckoResult<PromptDelegate.PromptResponse> {
        val r = GeckoResult<PromptDelegate.PromptResponse>()
        var done = false
        dlg().setTitle("重新提交表单？").setMessage("刷新这个页面会把刚才填的内容再提交一遍（比如再付一次款、再发一次帖）。")
            .setPositiveButton("重新提交") { _, _ -> done = true; r.complete(p.confirm(AllowOrDeny.ALLOW)) }
            .setNegativeButton("取消") { _, _ -> done = true; r.complete(p.confirm(AllowOrDeny.DENY)) }
            .setOnDismissListener { if (!done) r.complete(p.confirm(AllowOrDeny.DENY)) }.show()
        return r
    }

    fun confirmInstall(e: WebExtension, perms: Array<String>, origins: Array<String>, done: (Boolean) -> Unit) {
        val lines = (perms.toList() + origins.toList()).joinToString("\n") { "· $it" }
        var answered = false
        dlg().setTitle("安装扩展：${e.metaData.name ?: e.id}")
            .setMessage((e.metaData.description ?: "") + if (lines.isNotEmpty()) "\n\n需要的权限：\n$lines" else "")
            .setPositiveButton("安装") { _, _ -> answered = true; done(true) }
            .setNegativeButton("取消") { _, _ -> answered = true; done(false) }
            .setOnDismissListener { if (!answered) done(false) }.show()
    }
}
