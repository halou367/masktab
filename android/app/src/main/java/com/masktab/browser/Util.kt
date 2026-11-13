package com.masktab.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors

// 小工具：日志、线程、JSON、本地 HTTP。

const val TAG = "MaskTab"

fun logi(msg: String) { Log.i(TAG, msg) }
fun logw(msg: String, e: Throwable? = null) { Log.w(TAG, msg, e) }

val mainHandler = Handler(Looper.getMainLooper())
val worker = Executors.newCachedThreadPool()

fun ui(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
}

fun bg(block: () -> Unit) {
    worker.execute {
        try { block() } catch (e: Throwable) { logw("后台任务出错", e) }
    }
}

private val rnd = SecureRandom()

fun randomHex(bytes: Int): String {
    val b = ByteArray(bytes)
    rnd.nextBytes(b)
    return b.joinToString("") { "%02x".format(it) }
}

fun randomLong(): Long = rnd.nextLong() and 0x7fffffffffffL

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

fun JSONObject.str(k: String, def: String = ""): String = if (has(k) && !isNull(k)) optString(k, def) else def

fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
    return o
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray.strings(): List<String> = (0 until length()).map { optString(it) }

/** 原子写文件：先写临时文件再改名，断电不会留下半个文件。 */
fun writeAtomic(f: File, data: ByteArray) {
    f.parentFile?.mkdirs()
    val tmp = File(f.path + ".tmp")
    tmp.writeBytes(data)
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
}

class HttpResult(val code: Int, val body: String, val ms: Long)

/**
 * 发一个 HTTP 请求。proxyPort 非空时经本机 mihomo 的 mixed 入站（按 HTTP 代理用，HTTPS 走 CONNECT，域名交给代理解析）；
 * 为空时不走任何代理（Proxy.NO_PROXY，不受系统代理影响）。
 */
fun http(
    method: String, url: String, body: String? = null, headers: Map<String, String> = emptyMap(),
    proxyPort: Int? = null, timeoutMs: Int = 8000,
): HttpResult {
    val t0 = System.currentTimeMillis()
    val proxy = if (proxyPort != null) Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort)) else Proxy.NO_PROXY
    val c = URL(url).openConnection(proxy) as HttpURLConnection
    try {
        c.requestMethod = method
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "MaskTab-Android")
        for ((k, v) in headers) c.setRequestProperty(k, v)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val code = c.responseCode
        val s = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return HttpResult(code, s, System.currentTimeMillis() - t0)
    } finally {
        c.disconnect()
    }
}
