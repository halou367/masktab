package com.masktab.browser

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 核心服务（docs/decisions.md D-4）。
//
// 安卓版和电脑版用同一个核心服务：同一份 Go 代码编成 libmasktab.so 随安装包分发，app 把它当子进程启动（宿主模式）。
// 实例、订阅、出口 / 入口、地址库、选线、探测、密码库、设置都在核心服务里，和电脑版是同一套逻辑、同一套接口；
// app 只管三件事：GeckoView（标签页、容器、页面里的伪装）、界面外壳（地址栏、底部工具栏、弹出页的窗口）、把页面的请求转给核心服务。
// 所以以后改任何一个功能，改核心服务或共用的页面脚本，两端一起变。

/** 实例（核心服务状态的一份只读快照，[Host.refresh] 时整体换新）。 */
class Inst(
    val id: String, val no: Int, val name: String, val color: String,
    /** 这个实例在 mihomo 里的本地入站端口（0 = 还没启动过）。直连的实例也走这个端口，由 mihomo 直连出去。 */
    val port: Int,
    /** 指纹种子：同一实例不变，不同实例不同；“换指纹”时重新生成。 */
    val seed: Long,
    /** 网页看到的时区、语言（核心服务按出口或固定值算好的；空 = 不改）。 */
    val tz: String, val lang: String,
    val running: Boolean, val starting: Boolean,
    /** 代理是否开着（关 = 直连）。 */
    val on: Boolean,
    /** 出口国家（代理开着时头像角上的国旗）。 */
    val country: String,
    val ip: String,
    val error: String,
    // 下面几项只给外壳的头像菜单、标签页切换器显示用（2026-11-15，决策 UI-2）：都是核心服务算好的，这里只读
    /** 出口城市、延迟（毫秒；0 未测，-1 不通）。 */
    val city: String = "",
    val latency: Int = 0,
    /** 密码库里这个实例记住的账号数。 */
    val accounts: Int = 0,
    /** 伪装一致性检查：通过 / 能判断的项数（internal/core/checks.go）。 */
    val checksPass: Int = 0,
    val checksTotal: Int = 0,
    /** 出口 IP 的纯净度（-1 = 查不到）和类型（res / dc / mobile）。 */
    val purity: Int = -1,
    val ipType: String = "",
    /** CF 信誉：good = CF 那一路有出口；bad = 只有普通网站那一路；空 = 不知道。 */
    val cf: String = "",
) {
    val contextId get() = "mt-$id"
}

object Fp {
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
    fun cfg(i: Inst): JSONObject = jsonOf("id" to i.id, "no" to i.no, "seed" to i.seed, "tz" to i.tz, "lang" to i.lang, "port" to i.port, "direct" to false)
}

/** 核心服务子进程。 */
object CoreProc {
    private lateinit var ctx: Context
    lateinit var dir: File
        private set
    @Volatile private var proc: Process? = null
    @Volatile var port = 0
        private set
    @Volatile private var token = ""
    @Volatile var lastError = ""
        private set
    /** 进程被系统杀掉或自己退出后要做的事（重启、把开着的实例重新接上）。 */
    var onDied: (() -> Unit)? = null

    fun init(c: Context) { ctx = c; dir = File(c.filesDir, "core").apply { mkdirs() } }
    private val bin get() = File(ctx.applicationInfo.nativeLibraryDir, "libmasktab.so")
    private val mihomoBin get() = File(ctx.applicationInfo.nativeLibraryDir, "libmihomo.so")
    private val outFile get() = File(dir, "core.out")
    val installed get() = bin.exists()
    val mihomoInstalled get() = mihomoBin.exists()
    val running get() = proc?.isAlive == true && port > 0

    /** 启动核心服务并等它的本地接口就绪。已在运行就直接返回。在后台线程调用。 */
    @Synchronized
    fun start(): Boolean {
        if (running) return true
        lastError = ""
        if (!installed) { lastError = "安装包里没有核心服务（libmasktab.so）"; return false }
        proc?.destroy()
        port = 0
        val lock = File(dir, "state/running.lock")
        lock.delete()
        return try {
            val gecko = GeckoSession.getDefaultUserAgent().substringAfter("rv:").substringBefore(")")
            val pb = ProcessBuilder(bin.path, "-data", dir.path, "-host", "android", "-mihomo", mihomoBin.path, "-kernel-name", "GeckoView", "-kernel-version", gecko)
            val env = pb.environment()
            env["TMPDIR"] = ctx.cacheDir.path // 不设的话 Go 在安卓上用 /data/local/tmp，app 写不了
            env["HOME"] = ctx.filesDir.path
            VaultKey.get(ctx, dir)?.let { env["MASKTAB_VAULT_KEY"] = it }
            pb.redirectErrorStream(true).redirectOutput(outFile)
            // 标准输入留着不关：app 进程没了管道就断，核心服务发现后自己退出（连同 mihomo），不留孤儿进程
            val p = pb.start()
            proc = p
            var ok = false
            for (k in 1..100) { // 最多等 20 秒
                Thread.sleep(200)
                if (!p.isAlive) break
                val f = try { lock.readText().trim().split(Regex("\\s+")) } catch (e: Exception) { emptyList() }
                if (f.size == 2 && (f[0].toIntOrNull() ?: 0) > 0) {
                    port = f[0].toInt(); token = f[1]
                    if (ping()) { ok = true; break }
                    port = 0
                }
            }
            if (!ok) {
                lastError = if (p.isAlive) "核心服务没有响应" else "核心服务退出了：" + logTail(400)
                logw(lastError)
                p.destroy()
                false
            } else {
                logi("核心服务已启动，端口 $port")
                bg {
                    val code = try { p.waitFor() } catch (e: Exception) { -1 }
                    if (proc === p) {
                        port = 0
                        logw("核心服务退出了（退出码 $code）：" + logTail(300))
                        onDied?.invoke()
                    }
                }
                true
            }
        } catch (e: Exception) {
            lastError = "启动核心服务失败：${e.message}"
            logw(lastError, e)
            false
        }
    }

    private fun ping(): Boolean = try { call("GET", "/api/ping", timeoutMs = 1500).code == 200 } catch (e: Exception) { false }

    /** 调核心服务的本地接口。inst = 这个请求是哪个实例发的（电脑版由各实例的伴随扩展带上，这里由 app 代填）。 */
    fun call(method: String, path: String, body: String? = null, inst: String? = null, timeoutMs: Int = 30000): HttpResult {
        if (port == 0) throw IllegalStateException("核心服务没有在运行" + (if (lastError.isNotEmpty()) "：$lastError" else ""))
        val h = HashMap<String, String>()
        h["X-MaskTab-Token"] = token
        if (!inst.isNullOrEmpty()) h["X-MaskTab-Inst"] = inst
        var m = method
        if (m == "PATCH") { m = "POST"; h["X-MaskTab-Method"] = "PATCH" } // 安卓自带的 HTTP 客户端发不了 PATCH
        return http(m, "http://127.0.0.1:$port$path", body, h, timeoutMs = timeoutMs)
    }

    /** 调接口并取回 JSON；失败（含核心服务回的 {error}）抛异常，消息就是原因。 */
    fun json(method: String, path: String, body: JSONObject? = null, inst: String? = null, timeoutMs: Int = 30000): JSONObject {
        val r = call(method, path, body?.toString(), inst, timeoutMs)
        val j = try { JSONObject(r.body) } catch (e: Exception) { JSONObject() }
        if (r.code !in 200..299) throw RuntimeException(j.str("error").ifEmpty { "HTTP ${r.code}" })
        return j
    }

    /** 核心服务的日志尾部（它自己的输出，连同崩溃时的调用栈）。 */
    fun logTail(max: Int = 1500): String = try { outFile.readText().takeLast(max) } catch (e: Exception) { "" }
    fun mihomoLogTail(max: Int = 1200): String = try { File(dir, "core/mihomo.log").readText().takeLast(max) } catch (e: Exception) { "" }
}

/**
 * 密码库的密钥。核心服务用 AES-256-GCM 加密密码库，密钥由这里给（环境变量，只有本应用的进程读得到）：
 * 一把随机密钥，用系统密钥库（Keystore）里不可导出的密钥包着存盘。磁盘上没有明文密钥，把文件拷到别的手机也解不开。
 * 系统密钥库用不了时（个别机型）返回 null，核心服务退回到在应用私有目录里放密钥文件。
 */
object VaultKey {
    const val ALIAS = "masktab-vault"
    fun keystoreKey(): SecretKey {
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

    fun get(ctx: Context, dir: File): String? {
        val wrapped = File(dir, "vault.key.enc")
        if (!wrapped.exists() && File(dir, "config/vault.key").exists()) return null // 以前退回过密钥文件：继续用它，不然旧密码库解不开
        return try {
            val raw: ByteArray
            if (wrapped.exists()) {
                val b = wrapped.readBytes()
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, b, 0, 12))
                raw = c.doFinal(b, 12, b.size - 12)
            } else {
                raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.ENCRYPT_MODE, keystoreKey())
                writeAtomic(wrapped, c.iv + c.doFinal(raw))
            }
            if (raw.size != 32) throw IllegalStateException("密钥长度不对")
            Base64.encodeToString(raw, Base64.NO_WRAP)
        } catch (e: Exception) {
            logw("系统密钥库用不了，密码库密钥改放应用私有目录", e)
            if (wrapped.exists()) Host.vaultKeyError = "系统密钥库读不出密码库的密钥：${e.message}"
            null
        }
    }
}

/** 核心服务状态在 app 这边的快照，加上只属于 app 的一点状态（当前显示哪个实例）。 */
object Host {
    private lateinit var file: File
    @Volatile var insts: List<Inst> = emptyList()
        private set
    @Volatile var searchUrl = "https://www.bing.com/search?q=%s"
        private set
    /** 当前显示的实例。 */
    @Volatile var current = ""
    @Volatile var seq = 0L
        private set
    @Volatile var mihomoOk = false
        private set
    @Volatile var mihomoVersion = ""
        private set
    @Volatile var coreError = ""
        private set
    @Volatile var version = ""
        private set
    /** 订阅概况（启动页、诊断信息用）：名字只留域名。 */
    @Volatile var subs: List<String> = emptyList()
        private set
    @Volatile var nodeCount = 0
        private set
    @Volatile var vaultKeyError = ""
    /** 设置里的“外观”：dark（默认）| light | system。 */
    @Volatile var theme = "dark"
        private set
    /** 新标签页的书签（三点菜单里的星标按钮加 / 删）。 */
    @Volatile var bookmarks: List<Pair<String, String>> = emptyList()
        private set
    /** 已标记（录入过登录）的网站数。 */
    @Volatile var rules = 0
        private set
    /** 快照换新之后（主线程）。 */
    var onChange: ((old: List<Inst>) -> Unit)? = null

    fun init(c: Context) {
        file = File(c.filesDir, "host.json")
        try { current = JSONObject(file.readText()).str("current") } catch (e: Exception) { }
    }
    fun saveCurrent(id: String) {
        if (current == id) return
        current = id
        bg { writeAtomic(file, jsonOf("current" to id).toString().toByteArray()) }
    }
    fun get(id: String?): Inst? = insts.firstOrNull { it.id == id }
    fun cur(): Inst? = get(current) ?: insts.firstOrNull()

    /** 取一次最新状态。在后台线程调用；返回是否成功。 */
    fun refresh(): Boolean {
        val j = try { CoreProc.json("GET", "/api/state", timeoutMs = 10000) } catch (e: Exception) { logw("取核心服务状态失败：${e.message}"); return false }
        val list = ArrayList<Inst>()
        val ipq = j.optJSONObject("ipq") ?: JSONObject()
        for (o in j.optJSONArray("instances")?.objects() ?: emptyList()) {
            if (o.str("kind") == "normal") continue
            val rt = o.optJSONObject("rt") ?: JSONObject()
            val fi = o.optJSONObject("fpInfo") ?: JSONObject()
            val on = o.optJSONObject("proxy")?.str("state") == "on"
            val pr = rt.optJSONObject("probe")
            val ex = if (o.optJSONObject("tz")?.str("source") == "exit-direct") pr?.optJSONObject("direct") ?: pr?.optJSONObject("cf") else pr?.optJSONObject("cf") ?: pr?.optJSONObject("direct")
            list.add(Inst(
                id = o.str("id"), no = o.optInt("no"), name = o.str("name"), color = o.str("color", "#1A73E8"), port = o.optInt("port"),
                seed = fi.optLong("seed64"), tz = fi.str("tz"), lang = fi.str("lang"),
                running = rt.optBoolean("running"), starting = rt.optBoolean("starting"), on = on,
                country = ex?.str("country") ?: "", ip = ex?.str("ip") ?: "", error = rt.str("error"),
                city = ex?.str("city") ?: "", latency = rt.optInt("latency"), accounts = o.optJSONObject("acct")?.optInt("count") ?: 0,
                checksPass = o.optJSONObject("checks")?.optInt("pass") ?: 0, checksTotal = o.optJSONObject("checks")?.optInt("total") ?: 0,
                purity = ex?.str("ip")?.let { ipq.optJSONObject(it) }?.optInt("score", -1) ?: -1, ipType = ex?.str("ip")?.let { ipq.optJSONObject(it) }?.str("type") ?: "",
                cf = if (!on || pr == null) "" else if (pr.optJSONObject("cf") != null) "good" else if (pr.optJSONObject("direct") != null) "bad" else "",
            ))
        }
        val names = ArrayList<String>()
        var n = 0
        for (s in j.optJSONArray("subscriptions")?.objects() ?: emptyList()) {
            names.add(try { java.net.URI(s.str("url")).host ?: s.str("name") } catch (e: Exception) { s.str("name") })
            n += s.optJSONArray("nodes")?.length() ?: 0
        }
        val core = j.optJSONObject("core") ?: JSONObject()
        val old = insts
        insts = list
        subs = names; nodeCount = n
        val set = j.optJSONObject("settings") ?: JSONObject()
        searchUrl = set.str("searchUrl").ifEmpty { null } ?: searchUrl
        theme = set.str("theme").ifEmpty { "dark" }
        bookmarks = (set.optJSONArray("bookmarks")?.objects() ?: emptyList()).map { it.str("title") to it.str("url") }
        rules = j.optJSONObject("vault")?.optJSONArray("rules")?.length() ?: 0
        mihomoOk = core.optBoolean("ok"); mihomoVersion = core.str("version"); coreError = core.str("error").ifEmpty { j.optJSONObject("setup")?.str("coreError") ?: "" }
        version = j.str("version")
        seq = maxOf(seq, j.optLong("seq"))
        ui { onChange?.invoke(old) }
        return true
    }

    @Volatile private var watching = false
    /** 盯着核心服务的事件（长轮询）：一有变化就取新状态。 */
    fun watch() {
        if (watching) return
        watching = true
        Thread({
            var fails = 0
            while (true) {
                try {
                    if (!CoreProc.running) { Thread.sleep(1000); continue }
                    val j = CoreProc.json("GET", "/api/events?since=$seq", timeoutMs = 40000)
                    val s = j.optLong("seq")
                    if (s < seq) seq = s // 核心服务重启过，序号从头来
                    if (s != seq || (j.optJSONArray("events")?.length() ?: 0) > 0) { seq = s; refresh() }
                    fails = 0
                } catch (e: Throwable) {
                    fails++
                    try { Thread.sleep(if (fails > 5) 3000 else 500) } catch (x: InterruptedException) { }
                }
            }
        }, "masktab-watch").apply { isDaemon = true }.start()
    }

    /** 等到 [cond] 成立（每 250 毫秒取一次状态），最多等 [ms]。在后台线程调用。 */
    fun waitFor(ms: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (true) {
            refresh()
            if (cond()) return true
            if (System.currentTimeMillis() > end) return false
            Thread.sleep(250)
        }
    }
}

/**
 * 0.1.41 及以前的数据（实例和订阅在 state.json，密码在用系统密钥库加密的 vault.bin）搬进核心服务。
 * 只在核心服务里还没有任何实例时做一次；搬完把旧文件改名留底（.old），不删。
 */
object Legacy {
    fun migrate(ctx: Context): String? {
        val state = File(ctx.filesDir, "state.json")
        if (!state.exists()) return null
        if (Host.insts.isNotEmpty()) { state.renameTo(File(ctx.filesDir, "state.json.old")); return null }
        return try {
            val j = JSONObject(state.readText())
            val body = jsonOf("instances" to (j.optJSONArray("instances") ?: JSONArray()), "subUrl" to j.str("subUrl"), "searchUrl" to j.str("searchUrl"))
            val vf = File(ctx.filesDir, "vault.bin")
            var vaultNote = ""
            if (vf.exists()) {
                try {
                    val b = vf.readBytes()
                    val c = Cipher.getInstance("AES/GCM/NoPadding")
                    c.init(Cipher.DECRYPT_MODE, VaultKey.keystoreKey(), GCMParameterSpec(128, b, 0, 12))
                    val v = JSONObject(String(c.doFinal(b, 12, b.size - 12)))
                    body.put("default", v.str("default")).put("items", v.optJSONArray("items") ?: JSONArray()).put("rules", v.optJSONArray("rules") ?: JSONArray())
                } catch (e: Exception) {
                    vaultNote = "；旧密码库解不开（${e.message}），账号密码没有搬过来，旧文件留着没动"
                    logw("旧密码库解不开", e)
                }
            }
            val r = CoreProc.json("POST", "/api/host/import", body, timeoutMs = 90000)
            val cur = j.str("current")
            if (cur.isNotEmpty()) Host.saveCurrent(cur)
            state.renameTo(File(ctx.filesDir, "state.json.old"))
            if (vaultNote.isEmpty()) vf.renameTo(File(ctx.filesDir, "vault.bin.old"))
            val msg = "已搬入旧数据：${r.optInt("instances")} 个实例、${r.optInt("items")} 条账号、${r.optInt("rules")} 条录入规则" +
                (if (r.str("subError").isNotEmpty()) "；订阅这次没拉下来：${r.str("subError")}" else "") + vaultNote
            logi(msg)
            msg
        } catch (e: Exception) {
            logw("旧数据没有搬成：${e.message}", e)
            "旧数据没有搬成：${e.message}"
        }
    }
}
