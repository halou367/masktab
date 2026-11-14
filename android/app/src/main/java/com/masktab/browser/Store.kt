package com.masktab.browser

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 实例与设置：存 app 私有目录下的 state.json（不含密码；密码在 Vault 里加密保存）。

/** 实例调色板，与桌面 internal/model.Palette 相同，按编号循环。 */
val PALETTE = listOf("#1A73E8", "#D93025", "#F9AB00", "#188038", "#D01884", "#A142F4", "#007B83", "#FA903E", "#5F6368", "#3F51B5", "#C2185B", "#795548")

/** 每个实例在 mihomo 里的本地入站端口 = PORT_BASE + 编号。 */
const val PORT_BASE = 21000

class Inst(
    var id: String,
    var no: Int,
    var name: String = "",
    var color: String = PALETTE[0],
    var order: Int = 0,
    /** 节点：DIRECT = 直连；auto = 自动挑延迟最低的；其余 = 订阅里的节点名。 */
    var node: String = "DIRECT",
    /** 指纹种子：同一实例不变，不同实例不同；“换指纹”时重新生成。 */
    var seed: Long = 0,
    /** 时区：空 = 跟随出口。 */
    var tz: String = "",
    /** 语言：空 = 按出口国家。 */
    var lang: String = "",
    var createdAt: Long = System.currentTimeMillis(),
    /** node = auto 时上次实际选中的节点：下次启动优先接着用它，出口 IP 不乱跳。 */
    var last: String = "",
) {
    val contextId get() = "mt-$id"
    val port get() = PORT_BASE + no
    val direct get() = node == "DIRECT"

    fun toJson(): JSONObject = jsonOf(
        "id" to id, "no" to no, "name" to name, "color" to color, "order" to order, "node" to node,
        "seed" to seed, "tz" to tz, "lang" to lang, "createdAt" to createdAt, "last" to last,
    )

    companion object {
        fun from(j: JSONObject) = Inst(
            id = j.str("id"), no = j.optInt("no"), name = j.str("name"), color = j.str("color", PALETTE[0]),
            order = j.optInt("order"), node = j.str("node", "DIRECT"), seed = j.optLong("seed"),
            tz = j.str("tz"), lang = j.str("lang"), createdAt = j.optLong("createdAt"), last = j.str("last"),
        )
    }
}

/** 出口探测结果。 */
class Exit(val ip: String, val country: String, val city: String, val org: String, val tz: String) {
    fun toJson(): JSONObject = jsonOf("ip" to ip, "country" to country, "city" to city, "org" to org, "timezone" to tz)
}

/** 实例的运行时状态（不落盘）。 */
class Rt {
    var exit: Exit? = null
    var latency: Int = 0
    var probing = false
    var error = ""
    /** 这个实例在 mihomo 里实际选中的节点（换了节点时旧的出口信息作废）。 */
    var node = ""
    var cookies: JSONArray = JSONArray()
    var cookieN = 0
}

class Store(private val dir: File) {
    private val file = File(dir, "state.json")
    private val tabsFile = File(dir, "tabs.json")
    val insts = mutableListOf<Inst>()
    val rt = HashMap<String, Rt>()

    var subUrl = ""
    var searchUrl = "https://www.bing.com/search?q=%s"
    var current = ""
    var nextNo = 1

    @Synchronized
    fun load() {
        if (file.exists()) {
            try {
                val j = JSONObject(file.readText())
                insts.clear()
                j.optJSONArray("instances")?.objects()?.forEach { insts.add(Inst.from(it)) }
                subUrl = j.str("subUrl")
                searchUrl = j.str("searchUrl", searchUrl)
                current = j.str("current")
                nextNo = j.optInt("nextNo", 1)
            } catch (e: Exception) {
                logw("state.json 读取失败，按空状态启动", e)
            }
        }
        if (insts.isEmpty()) create()
        if (get(current) == null) current = sorted().first().id
        save()
    }

    @Synchronized
    fun save() {
        val j = jsonOf(
            "instances" to JSONArray(insts.map { it.toJson() }),
            "subUrl" to subUrl, "searchUrl" to searchUrl, "current" to current, "nextNo" to nextNo,
        )
        writeAtomic(file, j.toString(2).toByteArray())
    }

    @Synchronized
    fun create(name: String = ""): Inst {
        val no = nextNo++
        val i = Inst(
            id = randomHex(4), no = no, name = name,
            color = PALETTE[(no - 1) % PALETTE.size],
            order = (insts.maxOfOrNull { it.order } ?: 0) + 1,
            node = if (subUrl.isNotEmpty()) "auto" else "DIRECT",
            seed = randomLong(),
        )
        insts.add(i)
        save()
        return i
    }

    @Synchronized
    fun get(id: String?): Inst? = insts.firstOrNull { it.id == id }

    @Synchronized
    fun sorted(): List<Inst> = insts.sortedBy { it.order }

    @Synchronized
    fun cur(): Inst = get(current) ?: sorted().first()

    @Synchronized
    fun delete(id: String) {
        insts.removeAll { it.id == id }
        rt.remove(id)
        if (insts.isEmpty()) create()
        if (current == id) current = sorted().first().id
        save()
    }

    @Synchronized
    fun reorder(ids: List<String>) {
        ids.forEachIndexed { k, id -> get(id)?.order = k + 1 }
        save()
    }

    @Synchronized
    fun rtOf(id: String): Rt = rt.getOrPut(id) { Rt() }

    // ---------- 标签页（只存每个实例的网址列表与当前位置，用来下次启动恢复） ----------
    fun saveTabs(j: JSONObject) = writeAtomic(tabsFile, j.toString().toByteArray())

    fun loadTabs(): JSONObject = try { JSONObject(tabsFile.readText()) } catch (e: Exception) { JSONObject() }
}
