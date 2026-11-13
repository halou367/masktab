package com.masktab.browser

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 密码库（对应桌面 internal/vault）：整库 JSON 用 Android Keystore 里的 AES-256-GCM 密钥加密后落盘，
// 密钥不出 Keystore（不可导出）。条目按实例隔离；站点完全匹配；导入的邮箱账号记为站点 "*"。

class VItem(
    var id: String = "",
    var inst: String = "",
    var site: String = "",
    var user: String = "",
    var pass: String = "",
    var note: String = "",
    var src: String = "manual",
    var at: Long = 0,
) {
    fun toJson(): JSONObject = jsonOf("id" to id, "inst" to inst, "site" to site, "user" to user, "pass" to pass, "note" to note, "src" to src, "at" to at)

    companion object {
        fun from(j: JSONObject) = VItem(j.str("id"), j.str("inst"), j.str("site"), j.str("user"), j.str("pass"), j.str("note"), j.str("src", "manual"), j.optLong("at"))
    }
}

class Vault(dir: File) {
    private val file = File(dir, "vault.bin")
    private val items = mutableListOf<VItem>()
    private var def = ""
    var error = ""
        private set

    init {
        try { load() } catch (e: Exception) {
            error = "密码库读取失败：${e.message}"
            logw(error, e)
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return g.generateKey()
    }

    private fun load() {
        if (!file.exists()) return
        val b = file.readBytes()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        val j = JSONObject(String(c.doFinal(b, 12, b.size - 12)))
        def = j.str("default")
        items.clear()
        j.optJSONArray("items")?.objects()?.forEach { items.add(VItem.from(it)) }
    }

    private fun save() {
        val j = jsonOf("default" to def, "items" to JSONArray(items.map { it.toJson() }))
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(j.toString().toByteArray())
        writeAtomic(file, out)
    }

    private fun check() { if (error.isNotEmpty()) throw IllegalStateException(error) }

    @Synchronized fun default(): String = def

    @Synchronized fun setDefault(p: String) { check(); def = p; save() }

    @Synchronized fun list(inst: String): List<VItem> =
        items.filter { inst.isEmpty() || it.inst == inst }.sortedBy { it.site }.map { it.copy() }

    /** 能填进 site 的记录：本实例的排前，其次别的实例的，最后是本实例的 "*" 记录（与桌面 Vault.Match 相同）。 */
    @Synchronized fun match(inst: String, site: String): List<VItem> {
        val s = normSite(site)
        val mine = items.filter { it.site == s && it.inst == inst }
        val other = items.filter { it.site == s && it.inst != inst }
        val star = items.filter { it.site == "*" && it.inst == inst }
        return (mine + other + star).map { it.copy() }
    }

    @Synchronized fun upsert(it0: VItem): VItem {
        check()
        val it = it0.copy()
        it.site = normSite(it.site)
        require(it.site.isNotEmpty() && it.inst.isNotEmpty()) { "站点或实例为空" }
        if (it.src.isEmpty()) it.src = "manual"
        val x = if (it.id.isNotEmpty()) items.firstOrNull { e -> e.id == it.id }
        else items.firstOrNull { e -> e.inst == it.inst && e.site == it.site && e.user == it.user }
        if (x != null) {
            x.site = it.site; x.user = it.user; x.pass = it.pass; x.at = System.currentTimeMillis()
            if (it.note.isNotEmpty()) x.note = it.note
            save()
            return x.copy()
        }
        require(it.id.isEmpty()) { "记录不存在" }
        it.id = randomHex(6)
        it.at = System.currentTimeMillis()
        items.add(it)
        save()
        return it.copy()
    }

    @Synchronized fun delete(id: String) { check(); items.removeAll { it.id == id }; save() }

    @Synchronized fun deleteInst(inst: String) { check(); items.removeAll { it.inst == inst }; save() }

    /** 每个实例记住的站点主机名（最近修改在前，去重），卡片上的图标用。 */
    @Synchronized fun sites(): Map<String, List<String>> {
        val out = LinkedHashMap<String, MutableList<String>>()
        for (x in items.sortedByDescending { it.at }) {
            if (x.site == "*") continue
            val h = try { URI(x.site).host ?: continue } catch (e: Exception) { continue }
            val l = out.getOrPut(x.inst) { mutableListOf() }
            if (h !in l) l.add(h)
        }
        return out
    }

    @Synchronized fun count(): Map<String, Int> = items.groupingBy { it.inst }.eachCount()

    private fun VItem.copy() = VItem(id, inst, site, user, pass, note, src, at)

    companion object {
        private const val ALIAS = "masktab-vault"

        /** 规范化站点：scheme://host[:port]，默认端口省略；"*" 原样。与桌面 vault.NormSite 相同。 */
        fun normSite(s0: String): String {
            var s = s0.trim()
            if (s == "*" || s.isEmpty()) return s
            if (!s.contains("://")) s = "https://$s"
            return try {
                val u = URI(s)
                val host = u.host?.lowercase() ?: return ""
                val scheme = u.scheme.lowercase()
                var port = if (u.port > 0) u.port.toString() else ""
                if ((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) port = ""
                "$scheme://$host" + (if (port.isNotEmpty()) ":$port" else "")
            } catch (e: Exception) { "" }
        }

        /** 解析“导入邮箱”的文本：一行一个，可带密码（----、Tab、|、逗号、分号、空格、全角冒号、a@b.c:密码）。与桌面 vault.ParseEmails 相同。 */
        fun parseEmails(text: String): Pair<List<Pair<String, String>>, List<String>> {
            val seen = HashSet<String>()
            val out = mutableListOf<Pair<String, String>>()
            val bad = mutableListOf<String>()
            for (raw in text.replace("\r", "").split("\n")) {
                val line = raw.trim()
                if (line.isEmpty() || line.startsWith("#")) continue
                var email = line
                var pass = ""
                for (sep in listOf("----", "\t", "|", ",", ";", " ", "：")) {
                    val i = line.indexOf(sep)
                    if (i > 0) { email = line.substring(0, i).trim(); pass = line.substring(i + sep.length).trim(); break }
                }
                val ci = email.indexOf(':')
                if (ci > 0 && email.substring(0, ci).contains("@")) { pass = (email.substring(ci + 1) + pass).trim(); email = email.substring(0, ci) }
                email = email.lowercase()
                val at = email.indexOf('@')
                if (at <= 0 || !email.substring(at).contains(".") || email.any { it == ' ' || it == '/' || it == '\\' }) { bad.add(line); continue }
                if (!seen.add(email)) continue
                out.add(email to pass)
            }
            return out to bad
        }
    }
}
