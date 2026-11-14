package kernel

// Hosted 是宿主自己管的浏览器内核（安卓版的 GeckoView）：核心服务不启动它，也不知道它的目录。
// 指纹由宿主在页面里按种子伪装（画布、音频、核数、屏幕、时区、语言），系统和浏览器固定（UA 必须和内核一致）。
type Hosted struct{ Label string }

func (h Hosted) Name() string {
	if h.Label != "" {
		return h.Label
	}
	return "hosted"
}
func (Hosted) Caps() Caps                       { return Caps{Fingerprint: true, Timezone: true, Live: true} }
func (Hosted) Args(Launch) []string             { return nil }
func (Hosted) Env(Launch) []string              { return nil }
func (Hosted) ExtDataDirs(_, _ string) []string { return nil }
func (Hosted) PrefsPath(string) string          { return "" }
