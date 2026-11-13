package com.masktab.browser

import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession

// 出口探测与指纹参数。

object Probe {
    /** 经实例的端口（直连实例不走代理）查出口 IP、国家、时区。两个查询源轮流试。 */
    fun exit(inst: Inst, mihomoRunning: Boolean): Pair<Exit?, Int> {
        val port = if (inst.direct) null else inst.port
        if (port != null && !mihomoRunning) return null to -1
        try {
            val r = http("GET", "https://ipinfo.io/json", proxyPort = port, timeoutMs = 8000)
            if (r.code == 200) {
                val j = JSONObject(r.body)
                return Exit(j.str("ip"), j.str("country").uppercase(), j.str("city"), j.str("org"), j.str("timezone")) to r.ms.toInt()
            }
        } catch (e: Exception) { logw("ipinfo 探测失败：${e.message}") }
        try {
            val r = http("GET", "http://ip-api.com/json/?fields=status,query,countryCode,city,isp,timezone", proxyPort = port, timeoutMs = 8000)
            val j = JSONObject(r.body)
            if (j.str("status") == "success") {
                return Exit(j.str("query"), j.str("countryCode").uppercase(), j.str("city"), j.str("isp"), j.str("timezone")) to r.ms.toInt()
            }
        } catch (e: Exception) { logw("ip-api 探测失败：${e.message}") }
        return null to -1
    }
}

object Fp {
    /** 出口国家 → 网页看到的语言（没列到的用 en-US）。 */
    private val LANG = mapOf(
        "US" to "en-US", "GB" to "en-GB", "CA" to "en-CA", "AU" to "en-AU", "NZ" to "en-NZ", "IE" to "en-IE", "SG" to "en-SG", "IN" to "en-IN",
        "JP" to "ja-JP", "KR" to "ko-KR", "CN" to "zh-CN", "TW" to "zh-TW", "HK" to "zh-HK", "MO" to "zh-HK",
        "DE" to "de-DE", "AT" to "de-AT", "CH" to "de-CH", "FR" to "fr-FR", "BE" to "fr-BE", "ES" to "es-ES", "MX" to "es-MX", "AR" to "es-AR",
        "IT" to "it-IT", "PT" to "pt-PT", "BR" to "pt-BR", "NL" to "nl-NL", "RU" to "ru-RU", "UA" to "uk-UA", "PL" to "pl-PL", "TR" to "tr-TR",
        "SE" to "sv-SE", "NO" to "nb-NO", "DK" to "da-DK", "FI" to "fi-FI", "CZ" to "cs-CZ", "VN" to "vi-VN", "TH" to "th-TH", "ID" to "id-ID", "MY" to "ms-MY",
    )

    fun langFor(inst: Inst, exit: Exit?): String = inst.lang.ifEmpty { exit?.country?.let { LANG[it] } ?: "en-US" }

    fun tzFor(inst: Inst, exit: Exit?): String = inst.tz.ifEmpty { exit?.tz ?: "" }

    /**
     * 与种子对应的安卓火狐 UA：内核版本照实写（rv 与实际引擎一致，不伪装成 Chrome、不改版本号），
     * 只按种子换“Android 版本号”，不同实例不同、同一实例不变。
     */
    fun userAgent(seed: Long): String {
        val base = GeckoSession.getDefaultUserAgent()
        val v = listOf(12, 13, 14, 15)[((seed ushr 5) % 4).toInt()]
        return base.replace(Regex("Android [0-9.]+"), "Android $v")
    }

    /** 交给内置扩展的每实例参数（页面里的伪装由扩展的 fp.js 按种子推导）。 */
    fun cfg(inst: Inst, exit: Exit?): JSONObject = jsonOf(
        "id" to inst.id, "no" to inst.no, "seed" to inst.seed, "tz" to tzFor(inst, exit), "lang" to langFor(inst, exit),
    )
}
