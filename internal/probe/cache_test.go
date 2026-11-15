package probe

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/halou367/masktab/internal/model"
)

// 归属查询结果落盘：新进程读回来就不用再查（decisions A-13）；过期的不读。
func TestCacheFile(t *testing.T) {
	f := filepath.Join(t.TempDir(), "ipinfo.json")
	cacheMu.Lock()
	cache = map[string]cached{}
	cacheFile = f
	cache["1.1.1.1"] = cached{model.IPInfo{IP: "1.1.1.1", Country: "AU", Timezone: "Australia/Sydney"}, time.Now()}
	cache["2.2.2.2"] = cached{model.IPInfo{IP: "2.2.2.2", Country: "FR", Timezone: "Europe/Paris"}, time.Now().Add(-8 * 24 * time.Hour)}
	saveCacheLocked()
	cache = map[string]cached{}
	cacheMu.Unlock()
	LoadCache(f)
	if got := Lookup(nil, "1.1.1.1", "", nil); got.Timezone != "Australia/Sydney" {
		t.Fatalf("缓存没读回来：%+v", got)
	}
	cacheMu.Lock()
	_, old := cache["2.2.2.2"]
	cacheFile = ""
	cacheMu.Unlock()
	if old {
		t.Fatal("过期的不该读回来")
	}
}
