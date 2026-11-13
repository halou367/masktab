package com.masktab.browser

import android.app.Activity
import android.app.AlertDialog
import android.widget.EditText
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession.PromptDelegate
import org.mozilla.geckoview.WebExtension

// 网页弹框（alert / confirm / prompt / <select> 下拉）与安装扩展确认，用系统对话框实现。

class Prompts(private val a: Activity) {
    private fun dlg() = AlertDialog.Builder(a)

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
