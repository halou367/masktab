package com.masktab.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder

// mihomo 子进程（docs/android.md “代理”）：
// - 二进制随 APK 以 jniLibs/<abi>/libmihomo.so 分发，安装时解压到 nativeLibraryDir，从那里执行（安卓 10+ 不允许执行数据目录里的文件）。
// - 订阅用 proxy-providers（用户填 URL，mihomo 自己拉取、解析、定时刷新、健康检查）。
// - 每个实例一个 mixed 入站（127.0.0.1:21000+编号），直连实例的入站直接指向 DIRECT，其余指向自己的策略组 g-<id>。
// - 策略组第一项是 REJECT（与桌面硬规则 R-2 相同）：选节点失败、订阅拉不到时，这个实例的流量被拒绝，绝不回落直连。
// - external-controller 只监听 127.0.0.1，带随机 secret，用来列节点、测延迟、切换节点。

class Node(val name: String, val type: String, val alive: Boolean, val delay: Int) {
    fun toJson(): JSONObject = jsonOf("name" to name, "type" to type, "alive" to alive, "delay" to delay)
}

class Mihomo(ctx: Context) {
    private val bin = File(ctx.applicationInfo.nativeLibraryDir, "libmihomo.so")
    private val home = File(ctx.filesDir, "mihomo").apply { mkdirs() }
    private val cfgFile = File(home, "config.json")
    private val ctlPort = 19090
    private val secret = randomHex(16)
    @Volatile private var proc: Process? = null
    @Volatile var lastError = ""
        private set
    var version = ""
        private set

    val installed get() = bin.exists()
    val running get() = proc?.isAlive == true

    /**
     * 生成配置。输出 JSON（YAML 的子集，mihomo 直接能读），再经 [yamlSafeJson] 去掉 YAML 不认的转义。
     * 安卓的 org.json 会把每个 "/" 写成 "\/"，mihomo 的 YAML 解析器不认这个转义（报 found unknown escape character）。
     */
    fun config(store: Store): String {
        val insts = store.sorted()
        val hasSub = store.subUrl.isNotEmpty()
        val groups = JSONArray()
        val listeners = JSONArray()
        for (i in insts) {
            val proxy = if (i.direct || !hasSub) {
                if (i.direct) "DIRECT" else "REJECT"
            } else {
                groups.put(jsonOf("name" to "g-${i.id}", "type" to "select", "proxies" to JSONArray(listOf("REJECT")), "use" to JSONArray(listOf("sub"))))
                "g-${i.id}"
            }
            listeners.put(jsonOf("name" to "in-${i.id}", "type" to "mixed", "listen" to "127.0.0.1", "port" to i.port, "udp" to false, "proxy" to proxy))
        }
        val dnsList = JSONArray(listOf("https://223.5.5.5/dns-query", "https://1.1.1.1/dns-query", "223.5.5.5", "8.8.8.8"))
        val cfg = jsonOf(
            "allow-lan" to false, "bind-address" to "127.0.0.1", "mode" to "rule", "log-level" to "warning", "ipv6" to false,
            "unified-delay" to true,
            "external-controller" to "127.0.0.1:$ctlPort", "secret" to secret,
            "profile" to jsonOf("store-selected" to false, "store-fake-ip" to false),
            // 安卓上没有 /etc/resolv.conf，Go 的系统解析不可靠：解析一律走 mihomo 自己的 DNS（都写 IP，不依赖系统 DNS）
            "dns" to jsonOf(
                "enable" to true, "ipv6" to false, "enhanced-mode" to "redir-host",
                "default-nameserver" to JSONArray(listOf("223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8")),
                "nameserver" to dnsList, "proxy-server-nameserver" to dnsList,
            ),
            "proxies" to JSONArray(),
            "proxy-groups" to groups,
            "listeners" to listeners,
            "rules" to JSONArray(listOf("MATCH,REJECT")),
        )
        if (hasSub) {
            cfg.put("proxy-providers", jsonOf("sub" to jsonOf(
                // proxy: DIRECT 必须写：不写时拉订阅也走规则匹配，会被兜底的 MATCH,REJECT 拒掉（沙箱里实测）
                "type" to "http", "url" to store.subUrl, "interval" to 21600, "proxy" to "DIRECT", "path" to "./providers/sub.yaml",
                "header" to jsonOf("User-Agent" to JSONArray(listOf("clash.meta"))),
                "health-check" to jsonOf("enable" to true, "url" to "https://www.gstatic.com/generate_204", "interval" to 600, "timeout" to 5000, "lazy" to false),
            )))
        }
        return yamlSafeJson(cfg.toString(2))
    }

    /** 启动（已在运行则重新加载配置）。返回是否成功。 */
    @Synchronized
    fun start(store: Store): Boolean {
        lastError = ""
        if (!installed) { lastError = "安装包里没有 mihomo"; return false }
        writeAtomic(cfgFile, config(store).toByteArray())
        if (running && ping()) return reload()
        proc?.destroy()
        return try {
            val pb = ProcessBuilder(bin.path, "-d", home.path, "-f", cfgFile.path)
                .redirectErrorStream(true)
                .redirectOutput(File(home, "mihomo.log"))
            proc = pb.start()
            var ok = false
            for (k in 1..50) {
                Thread.sleep(200)
                if (ping()) { ok = true; break }
                if (proc?.isAlive != true) break
            }
            if (!ok) {
                lastError = if (proc?.isAlive == true) "mihomo 没有响应：$pingErr" else "mihomo 退出了：" + tailLog()
                false
            } else true
        } catch (e: Exception) {
            lastError = "启动 mihomo 失败：${e.message}"
            false
        }
    }

    @Synchronized
    fun stop() { proc?.destroy(); proc = null }

    private fun tailLog(): String = try { File(home, "mihomo.log").readText().takeLast(300) } catch (e: Exception) { "" }

    private fun ctl(method: String, path: String, body: String? = null, timeoutMs: Int = 5000): HttpResult =
        http(method, "http://127.0.0.1:$ctlPort$path", body, mapOf("Authorization" to "Bearer $secret"), timeoutMs = timeoutMs)

    @Volatile private var pingErr = ""
    fun ping(): Boolean = try {
        val r = ctl("GET", "/version", timeoutMs = 1000)
        if (r.code == 200) version = JSONObject(r.body).str("version")
        pingErr = if (r.code == 200) "" else "HTTP ${r.code}"
        r.code == 200
    } catch (e: Exception) { pingErr = e.message ?: e.javaClass.simpleName; false }

    private fun reload(): Boolean = try {
        val r = ctl("PUT", "/configs?force=true", jsonOf("path" to cfgFile.path).toString(), 15000)
        if (r.code !in 200..299) lastError = "重新加载配置失败：${r.body.take(200)}"
        r.code in 200..299
    } catch (e: Exception) { lastError = "重新加载配置失败：${e.message}"; false }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /** 订阅里的节点（含 mihomo 健康检查记下的延迟）。订阅没拉到时为空。 */
    fun nodes(): List<Node> = try {
        val r = ctl("GET", "/providers/proxies/sub")
        if (r.code != 200) emptyList() else JSONObject(r.body).optJSONArray("proxies")?.objects()?.map { p ->
            val hist = p.optJSONArray("history")
            val d = if (hist != null && hist.length() > 0) hist.getJSONObject(hist.length() - 1).optInt("delay") else 0
            Node(p.str("name"), p.str("type"), p.optBoolean("alive", d > 0), d)
        } ?: emptyList()
    } catch (e: Exception) { emptyList() }

    /** 订阅加载情况：null = 还没加载。 */
    fun providerInfo(): JSONObject? = try {
        val r = ctl("GET", "/providers/proxies/sub")
        if (r.code == 200) JSONObject(r.body) else null
    } catch (e: Exception) { null }

    /** 对订阅全部节点测一次延迟（mihomo 并发做，最多等 30 秒）。 */
    fun healthcheck() { try { ctl("GET", "/providers/proxies/sub/healthcheck", timeoutMs = 30000) } catch (e: Exception) { logw("测速失败", e) } }

    /** 单个节点测延迟（毫秒，失败返回 -1）。 */
    fun delay(name: String): Int = try {
        // 订阅（provider）里的节点不在 /proxies 下，要走 /providers/proxies/<订阅>/<节点>/healthcheck
        val r = ctl("GET", "/providers/proxies/sub/${enc(name)}/healthcheck?timeout=5000&url=${enc("https://www.gstatic.com/generate_204")}", timeoutMs = 7000)
        if (r.code == 200) JSONObject(r.body).optInt("delay", -1).let { if (it <= 0) -1 else it } else -1
    } catch (e: Exception) { -1 }

    fun select(inst: Inst, name: String): Boolean = try {
        ctl("PUT", "/proxies/${enc("g-${inst.id}")}", jsonOf("name" to name).toString()).code in 200..299
    } catch (e: Exception) { false }

    /** 每次加载配置后各实例的策略组都落回 REJECT，这里按实例的设置选回节点。auto = 延迟最低的可用节点。 */
    fun applySelections(store: Store) {
        if (!running || store.subUrl.isEmpty()) return
        val ns = nodes()
        val best = ns.filter { it.alive && it.delay > 0 }.minByOrNull { it.delay } ?: ns.firstOrNull()
        for (i in store.sorted()) {
            if (i.direct) continue
            val want = if (i.node == "auto") best?.name else ns.firstOrNull { it.name == i.node }?.name
            val rt = store.rtOf(i.id)
            if (want == null) {
                rt.error = if (ns.isEmpty()) "订阅还没有可用节点" else "节点“${i.node}”已不在订阅里"
                continue
            }
            rt.error = if (select(i, want)) "" else "切换节点失败"
        }
    }

    /** 实例当前实际在用的节点名。 */
    fun selected(inst: Inst): String = try {
        val r = ctl("GET", "/proxies/${enc("g-${inst.id}")}")
        if (r.code == 200) JSONObject(r.body).str("now") else ""
    } catch (e: Exception) { "" }
}

/**
 * 把 org.json 输出的 JSON 变成 YAML 解析器也认的写法：字符串里的 "\/" 换回 "/"。
 * 逐字符扫描，反斜杠后面的字符原样跟着走，所以 "\\/"（字面的反斜杠 + 斜杠）不会被拆错。
 * org.json 其余的转义（\" \\ \b \f \n \r \t \uXXXX）都在 YAML 双引号字符串的转义表里；非 ASCII 字符原样输出（UTF-8）。
 */
fun yamlSafeJson(json: String): String {
    val sb = StringBuilder(json.length)
    var i = 0
    while (i < json.length) {
        val c = json[i]
        if (c == '\\' && i + 1 < json.length) {
            val n = json[i + 1]
            if (n != '/') sb.append(c)
            sb.append(n)
            i += 2
        } else { sb.append(c); i++ }
    }
    return sb.toString()
}
