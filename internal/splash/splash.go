// Package splash 是屏幕中间那张小提示卡：图标、“MaskTab”、一行说明、一条进度（决策 UI-29）。
//
// 什么时候出现：启动后要等一会儿才有窗口的时候（清理上次留下的进程、一口气恢复好几个实例），
// 以及在线更新的全程——旧程序关窗口、安装程序换文件、新程序把实例开回来，这三段是三个进程，
// 各自在同一个位置显示同一张卡，看上去是一张卡在换字，中间不会有“什么都没有、不知道在干嘛”的十几秒。
//
// 只在 Windows 上有（splash_windows.go）；别的系统上这些函数什么都不做。
package splash

// 窗口的类名和两种标题：核心服务自己的那张，和安装程序那一段的那张（masktab.exe -splash update，
// 新的核心服务起来以后把它关掉，安装程序也靠这个标题等它关）。
const (
	Class      = "MaskTabSplash"
	TitleOwn   = "MaskTab"
	TitleSetup = "MaskTabUpdateSplash"
)
