// Package model 定义落盘与接口共用的数据结构（对应计划 7.1，JSON 字段名与计划一致）。
package model

type Instance struct {
	ID         string    `json:"id"`
	UpdatedAt  int64     `json:"updatedAt"`
	Deleted    bool      `json:"deleted,omitempty"`
	No         int       `json:"no"`   // 0 = 普通；1,2,3… 只增不复用
	Kind       string    `json:"kind"` // normal | persistent | disposable
	Name       string    `json:"name,omitempty"`
	Color      string    `json:"color"` // #RRGGBB
	CreatedAt  int64     `json:"createdAt"`
	LastUsedAt int64     `json:"lastUsedAt"`
	Port       int       `json:"port"`
	Proxy      InstProxy `json:"proxy"`
	FP         FP        `json:"fp"`
	TZ         TZ        `json:"tz"`
	Locale     Locale    `json:"locale"`
}

type InstProxy struct {
	State          string `json:"state"` // on | off（off = 直连）
	SubscriptionID string `json:"subscriptionId,omitempty"`
	ExitID         string `json:"exitId,omitempty"`
	ExitIP         string `json:"exitIp,omitempty"`
	Auto           bool   `json:"auto"`                  // 旧字段（一个开关管入口和出口）。现在只在升级时读一次，之后跟着 ExitMode 写
	ExitMode       string `json:"exitMode,omitempty"`    // 出口：auto = 只定国家，程序在这个国家里挑，不通自动换 | manual = 钉死 ExitID，不通也不换
	EntryMode      string `json:"entryMode,omitempty"`   // 入口：auto = 跟着出口（同一台机器能当入口就用它，否则挑延迟最低的）| manual = 钉死 AddressID
	Region         string `json:"region,omitempty"`      // 出口自动时限定的国家（国家代码，如 KR）；空 = 不限
	EntryRegion    string `json:"entryRegion,omitempty"` // 入口自动时先在哪个国家里挑（国家代码）；空 = 跟随出口。只对 edgetunnel 有意义
	Profile        string `json:"profile,omitempty"`     // 用订阅里的哪一套连接参数（Subscription.Profiles 的 key）；空 = 自动分配
	AddressMode    string `json:"addressMode"`           // same-as-exit | custom
	AddressID      string `json:"addressId,omitempty"`
	Host           string `json:"host,omitempty"`
	NodeKey        string `json:"nodeKey,omitempty"`
}

// ExitAuto / EntryAuto：没写过的（空）按自动算，这是默认值。
func (p InstProxy) ExitAuto() bool  { return p.ExitMode != "manual" }
func (p InstProxy) EntryAuto() bool { return p.EntryMode != "manual" }

type FP struct {
	Seed                string   `json:"seed"`               // 32 字节 base64
	Platform            string   `json:"platform,omitempty"` // windows | macos | linux；空 = 与本机一致
	Brand               string   `json:"brand,omitempty"`    // Chrome | Edge | Opera | Vivaldi；空 = Chrome
	HardwareConcurrency int      `json:"hardwareConcurrency,omitempty"`
	PlatformVersion     string   `json:"platformVersion,omitempty"`
	DisableSpoofing     []string `json:"disableSpoofing"`
}

type TZ struct {
	Mode   string `json:"mode"`   // auto | fixed
	Source string `json:"source"` // exit-cf | exit-direct
	Fixed  string `json:"fixed,omitempty"`
}

type Locale struct {
	Mode  string `json:"mode"` // follow-exit | fixed
	Fixed string `json:"fixed,omitempty"`
}

type ProxyNode struct {
	Key  string         `json:"key"`
	Name string         `json:"name"`
	Raw  map[string]any `json:"raw"` // mihomo 的 proxy 对象
}

type Template struct {
	Base     map[string]any `json:"base"`
	BasePath string         `json:"basePath"`
}

// Profile 是 edgetunnel 订阅里的一套连接参数：同一个凭据、同一种协议和传输、同一个 Host（或同一个通配域名下的一组随机 Host）。
// 一个订阅通常只有一套；同时开了 ws 和 xhttp、或者配了几个域名的订阅会有几套，实例可以在它们之间切换。
type Profile struct {
	Key      string   `json:"key"`
	Host     string   `json:"host"`  // 展示用：单个 Host，或 *.example.com
	Hosts    []string `json:"hosts"` // 实际可用的 Host；多于一个时按实例平分（计划 8.3）
	Type     string   `json:"type"`  // vless | trojan
	Net      string   `json:"net"`   // ws | xhttp
	Template Template `json:"template"`
}

type Subscription struct {
	ID          string      `json:"id"`
	UpdatedAt   int64       `json:"updatedAt"`
	Deleted     bool        `json:"deleted,omitempty"`
	Name        string      `json:"name"`
	URL         string      `json:"url"`
	Kind        string      `json:"kind"` // edgetunnel | generic
	KindLocked  bool        `json:"kindLocked"`
	ViaProxy    bool        `json:"viaProxy"`
	FetchedAt   int64       `json:"fetchedAt,omitempty"`
	ContentHash string      `json:"contentHash,omitempty"`
	LastError   string      `json:"lastError,omitempty"`
	Nodes       []ProxyNode `json:"nodes"`
	Template    *Template   `json:"template,omitempty"`
	Hosts       []string    `json:"hosts"`
	Profiles    []Profile   `json:"profiles,omitempty"` // edgetunnel：订阅里的全部连接参数；Template / Hosts 是第一套的（旧数据只有它们）
	// ECHOff：不使用订阅里的 ECH。全部节点都因 ECH 连不上时由测速自动置上（这个网络拿不到或用不了 ECH 配置），也可以手动开关。
	ECHOff bool `json:"echOff,omitempty"`
	HasECH bool `json:"hasEch,omitempty"` // 订阅里的节点带 ECH
}

type Address struct {
	ID             string `json:"id"`
	UpdatedAt      int64  `json:"updatedAt"`
	Deleted        bool   `json:"deleted,omitempty"`
	Server         string `json:"server"`
	Port           int    `json:"port"`
	Label          string `json:"label,omitempty"`
	Source         string `json:"source"` // subscription | custom
	SubscriptionID string `json:"subscriptionId,omitempty"`
	// Gone：已不在最新一次拉取的订阅里。有的订阅每次拉取都随机给一批地址，测过可用的会留下来继续用。
	Gone bool `json:"gone,omitempty"`
}

type ExitEntry struct {
	ID            string   `json:"id"`
	UpdatedAt     int64    `json:"updatedAt"`
	Deleted       bool     `json:"deleted,omitempty"`
	Type          string   `json:"type"` // proxyip | socks5 | http
	Value         string   `json:"value"`
	Label         string   `json:"label,omitempty"`
	Expand        bool     `json:"expand"`
	RefreshHours  int      `json:"refreshHours"`
	Resolved      []string `json:"resolved"`
	ResolvedAt    int64    `json:"resolvedAt,omitempty"`
	UsableAsEntry *bool    `json:"usableAsEntry,omitempty"`
}

type IPInfo struct {
	IP       string `json:"ip"`
	Country  string `json:"country"`
	Region   string `json:"region,omitempty"`
	City     string `json:"city,omitempty"`
	Timezone string `json:"timezone,omitempty"`
	Org      string `json:"org,omitempty"`
	Approx   bool   `json:"approx,omitempty"` // 时区来自"国家→默认时区"兜底表
}

// NodeScan 是一条候选线路（入口地址、反代或通用节点）最近一次测速 / 出口探测的结果。
type NodeScan struct {
	Delay int     `json:"delay"`          // 往返延迟，毫秒（连接建好之后一次请求的来回，不含握手）；0 未测；-1 不通
	Exit  *IPInfo `json:"exit,omitempty"` // 经它访问非 Cloudflare 站点时对方看到的 IP
	CF    *IPInfo `json:"cf,omitempty"`   // 经它访问托管在 Cloudflare 上的站点时对方看到的 IP（入口：不指定反代时；反代：用它时）
	Err   string  `json:"err,omitempty"`  // 不通的原因
	At    int64   `json:"at,omitempty"`
	// 以下由"直接探测"得到（edgetunnel 的入口地址和反代，不经代理内核）
	Kind     string  `json:"kind,omitempty"`     // cf = Cloudflare 官方 IP（只能当入口）| proxy = 反代（入口、反代都能当）
	Colo     string  `json:"colo,omitempty"`     // 落在的 Cloudflare 机房代码
	TCP      int     `json:"tcp,omitempty"`      // TCP 握手耗时，毫秒
	Speed    float64 `json:"speed,omitempty"`    // 下载峰值，Mbps
	SpeedAvg float64 `json:"speedAvg,omitempty"` // 下载平均，Mbps
	SpeedAt  int64   `json:"speedAt,omitempty"`
	SpeedErr string  `json:"speedErr,omitempty"`
}

// IPQ 是一个出口 IP 的"成色"：是住宅还是机房、纯净度多少。来自第三方查询，查不到不影响使用。
type IPQ struct {
	Type  string `json:"type,omitempty"` // res 住宅 | dc 机房 | mobile 移动；空 = 不知道
	Score int    `json:"score"`          // 纯净度 0–100，越高越干净；-1 = 不知道
	Src   string `json:"src,omitempty"`  // 数据来源
	At    int64  `json:"at"`
}

type ExitProbe struct {
	CF     *IPInfo `json:"cf,omitempty"`
	Direct *IPInfo `json:"direct,omitempty"`
	At     int64   `json:"at"`
	Error  string  `json:"error,omitempty"`
}

type GlobalExtension struct {
	ID            string   `json:"id"`
	UpdatedAt     int64    `json:"updatedAt"`
	Deleted       bool     `json:"deleted,omitempty"`
	ExtID         string   `json:"extId"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Source        string   `json:"source"` // store | file
	Enabled       bool     `json:"enabled"`
	Scope         string   `json:"scope"` // all | selected
	InstanceIDs   []string `json:"instanceIds"`
	Data          string   `json:"data"` // isolated | shared
	MasterVersion int      `json:"masterVersion"`
	MasterFrom    int      `json:"masterFrom,omitempty"` // 主数据来自哪个实例编号
	MasterAt      int64    `json:"masterAt,omitempty"`
	Warn          string   `json:"warn,omitempty"`
}

type Settings struct {
	SchemaVersion         int      `json:"schemaVersion"`
	DefaultSubscriptionID string   `json:"defaultSubscriptionId,omitempty"`
	NewExtData            string   `json:"newExtData"`         // shared（已确认的默认）| isolated
	AddressModeDefault    string   `json:"addressModeDefault"` // custom | same-as-exit
	ExitPick              string   `json:"exitPick"`           // unused | none
	RestoreOnStart        bool     `json:"restoreOnStart"`
	SearchURL             string   `json:"searchUrl"`
	KernelPath            string   `json:"kernelPath,omitempty"` // 手动指定内核可执行文件
	Kernel                string   `json:"kernel"`               // fingerprint-chromium | ungoogled
	Mirror                string   `json:"mirror,omitempty"`     // GitHub 下载镜像前缀，如 https://ghfast.top/
	DelayURL              string   `json:"delayUrl"`
	PathTemplate          string   `json:"pathTemplate"` // query | segment（8.4）
	SubRefreshHours       int      `json:"subRefreshHours"`
	IPInfoEndpoints       []string `json:"ipInfoEndpoints"`
	TZSourceDefault       string   `json:"tzSourceDefault"`     // exit-cf | exit-direct
	IPQOff                bool     `json:"ipqOff,omitempty"`    // 不向第三方查询出口 IP 的类型和纯净度
	BindIface             string   `json:"bindIface,omitempty"` // 出站绑定的网卡：空 = 自动识别物理网卡（绕过 TUN）；off = 不绑定；其它 = 网卡名
	// 界面（2026-11-15，Chrome 风格界面，decisions UI-1）：两端共用
	Theme     string     `json:"theme,omitempty"`     // 外观：空 / system = 跟随浏览器或系统的深浅色（默认）| dark 深色 | light 浅色
	Bookmarks []Bookmark `json:"bookmarks,omitempty"` // 新标签页上的书签（全部实例共用）
	NTPHide   []string   `json:"ntpHide,omitempty"`   // 新标签页上不显示的部分：card | bookmarks | recent | accounts
	// 人机验证诊断（只有手机用，decisions A-9）：这里列出的伪装项暂时关掉，用来定位“验证过不去”是哪一项引起的。
	// canvas | audio | hw | lang | tz | cfframe | block | ua | tp | fpp | sw；核心服务只存不解释，由 app 和内置扩展执行。
	FPOff []string `json:"fpOff,omitempty"`
}

// Bookmark 是新标签页上的一个书签。
type Bookmark struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

func DefaultSettings() Settings {
	return Settings{
		SchemaVersion: 1, NewExtData: "shared", AddressModeDefault: "custom", ExitPick: "unused",
		RestoreOnStart: true, SearchURL: "https://www.bing.com/search?q=%s", Kernel: "fingerprint-chromium",
		DelayURL: "https://www.gstatic.com/generate_204", PathTemplate: "query", SubRefreshHours: 6,
		IPInfoEndpoints: []string{"https://ipinfo.io/{ip}/json", "https://ipwho.is/{ip}", "http://ip-api.com/json/{ip}"},
		TZSourceDefault: "exit-cf",
	}
}

// Palette 实例调色板（计划 6.2），按创建顺序循环。
var Palette = []string{"#1A73E8", "#D93025", "#F9AB00", "#188038", "#D01884", "#A142F4", "#007B83", "#FA903E", "#5F6368", "#3F51B5", "#C2185B", "#795548"}
