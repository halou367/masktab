package extlib

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func pbBytes(field uint64, b []byte) []byte {
	out := binary.AppendUvarint(nil, field<<3|2)
	out = binary.AppendUvarint(out, uint64(len(b)))
	return append(out, b...)
}

func makeZip(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, c := range files {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(c))
	}
	_ = zw.Close()
	return buf.Bytes()
}

func TestInstallCRX3(t *testing.T) {
	pub := []byte("fake-public-key-der-bytes-for-test")
	other := []byte("another-key")
	want := IDFromKey(pub)
	crxID := make([]byte, 16)
	for i := 0; i < 16; i++ {
		crxID[i] = (want[2*i]-'a')<<4 | (want[2*i+1] - 'a')
	}
	hdr := append(pbBytes(2, pbBytes(1, other)), pbBytes(2, append(pbBytes(1, pub), pbBytes(2, []byte("sig"))...))...)
	hdr = append(hdr, pbBytes(10000, pbBytes(1, crxID))...)
	z := makeZip(t, map[string]string{
		"manifest.json":             `{"manifest_version":3,"name":"__MSG_appName__","version":"1.2.3","default_locale":"en","permissions":["storage","cookies"],"update_url":"https://x"}`,
		"_locales/en/messages.json": `{"appName":{"message":"Demo Ext"}}`,
		"_metadata/verified.json":   `{}`,
		"bg.js":                     `1`,
	})
	crx := append([]byte("Cr24"), binary.LittleEndian.AppendUint32(nil, 3)...)
	crx = binary.LittleEndian.AppendUint32(crx, uint32(len(hdr)))
	crx = append(append(crx, hdr...), z...)
	lib := t.TempDir()
	info, err := Install(lib, crx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info.ExtID != want || info.Version != "1.2.3" || info.Name != "Demo Ext" || info.Warn == "" {
		t.Fatalf("入库结果不对：%+v（期望 ID %s）", info, want)
	}
	dir := filepath.Join(lib, want, "1.2.3")
	if _, err := os.Stat(filepath.Join(dir, "_metadata")); err == nil {
		t.Error("_metadata 应被删除")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["key"] == nil || m["update_url"] != nil {
		t.Errorf("manifest 应写入 key 并去掉 update_url：%s", b)
	}
	if _, err := Install(lib, makeZip(t, map[string]string{"manifest.json": `{"manifest_version":2,"name":"x","version":"1"}`}), nil); err == nil {
		t.Error("Manifest V2 应被拒绝")
	}
	if id := ParseStoreID("https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=zh-CN"); id != "ddkjiahejlhfcafbddmgiahcphecmpfh" {
		t.Errorf("ParseStoreID = %q", id)
	}
}

func TestSharedSync(t *testing.T) {
	root := t.TempDir()
	master := filepath.Join(root, "master")
	mk := func(inst string) []string {
		return []string{filepath.Join(root, inst, "Local Extension Settings", "x"), filepath.Join(root, inst, "IndexedDB", "x")}
	}
	write := func(p, c string) {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte(c), 0o600)
	}
	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	a, b := mk("a"), mk("b")
	write(filepath.Join(a[0], "000003.log"), "A1")
	write(filepath.Join(a[0], "LOCK"), "")
	write(filepath.Join(b[0], "000003.log"), "B-own")
	write(filepath.Join(b[1], "stale"), "old")
	if err := Pull(master, b); err != nil || read(filepath.Join(b[0], "000003.log")) != "B-own" {
		t.Fatal("没有主数据时 Pull 不应改动实例数据")
	}
	h := Hash(a)
	write(filepath.Join(a[0], "LOG"), "noise")
	if Hash(a) != h {
		t.Error("LOG / LOCK 的变化不应影响哈希")
	}
	if err := Push(master, a, 3); err != nil {
		t.Fatal(err)
	}
	if err := Pull(master, b); err != nil {
		t.Fatal(err)
	}
	if read(filepath.Join(b[0], "000003.log")) != "A1" {
		t.Error("Pull 后 B 应得到 A 的数据")
	}
	if _, err := os.Stat(b[1]); err == nil {
		t.Error("主数据里没有的目录应被清掉")
	}
	if Hash(a) != Hash(b) {
		t.Error("Pull 后两边哈希应相同")
	}
	for i, c := range []string{"A2", "A3", "A4", "A5"} {
		write(filepath.Join(a[0], "000003.log"), c)
		if err := Push(master, a, 3); err != nil {
			t.Fatal(i, err)
		}
	}
	bk := Backups(master)
	if len(bk) != 3 {
		t.Fatalf("备份应保留 3 份，实际 %d", len(bk))
	}
	if err := Rollback(master, bk[0]); err != nil {
		t.Fatal(err)
	}
	_ = Pull(master, b)
	if got := read(filepath.Join(b[0], "000003.log")); got != "A4" {
		t.Errorf("回滚到上一份后应为 A4，实际 %s", got)
	}
}

// 本地文件夹的扩展（manifest 里没带密钥）：再入库一次要还是同一个 ID、原地换文件（目录不动），并说清楚变了什么。
// 以前每次入库都新生成一把密钥，同一个文件夹加几次就是几个“不同的”扩展。
func TestInstallDirAgain(t *testing.T) {
	src, lib := t.TempDir(), t.TempDir()
	put := func(name, body string) {
		p := filepath.Join(src, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("manifest.json", `{"manifest_version":3,"name":"Dev Ext","version":"2.2.0","background":{"service_worker":"bg.js"}}`)
	put("bg.js", "1")
	put("lib/old.js", "old")
	put(".git/HEAD", "ref")
	first, err := InstallDir(lib, src, nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(lib, first.ExtID, "2.2.0")
	if first.Replaced || first.Changed || first.ManifestChanged {
		t.Fatalf("第一次入库不该算“原地换”：%+v", first)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Fatal(".git 不该进库")
	}
	asked := ""
	keyFor := func(name string) []byte { asked = name; return KeyOf(dir) }

	// 一模一样再来一次：同一个 ID，什么都没变
	again, err := InstallDir(lib, src, keyFor)
	if err != nil || again.ExtID != first.ExtID || asked != "Dev Ext" || !again.Replaced || again.Changed || again.ManifestChanged {
		t.Fatalf("原样再入库：%+v %v（问的名字 %q）", again, err, asked)
	}
	// 只改代码：文件变了，manifest 没变；多出来的旧文件要删掉，新文件要有
	put("bg.js", "2")
	put("lib/new.js", "new")
	_ = os.Remove(filepath.Join(src, "lib", "old.js"))
	code, err := InstallDir(lib, src, keyFor)
	if err != nil || code.ExtID != first.ExtID || !code.Replaced || !code.Changed || code.ManifestChanged {
		t.Fatalf("只改代码：%+v %v", code, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "bg.js")); string(b) != "2" {
		t.Fatalf("库里的文件没换：%q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, "lib", "old.js")); err == nil {
		t.Fatal("源里删掉的文件，库里也该删")
	}
	if _, err := os.Stat(filepath.Join(dir, "lib", "new.js")); err != nil {
		t.Fatal("源里新加的文件，库里该有")
	}
	// 改 manifest（版本号没动）
	put("manifest.json", `{"manifest_version":3,"name":"Dev Ext","version":"2.2.0","permissions":["storage"],"background":{"service_worker":"bg.js"}}`)
	man, err := InstallDir(lib, src, keyFor)
	if err != nil || man.ExtID != first.ExtID || !man.Changed || !man.ManifestChanged {
		t.Fatalf("改 manifest：%+v %v", man, err)
	}
	// 不给以前的密钥（= 以前的做法）：会是另一个 ID
	other, err := InstallDir(lib, src, nil)
	if err != nil || other.ExtID == first.ExtID {
		t.Fatalf("没有以前的密钥时应当是新的 ID：%+v %v", other, err)
	}
	// 源自己带了密钥：以它为准，不问
	asked = ""
	put("manifest.json", `{"manifest_version":3,"name":"Dev Ext","version":"2.2.0","key":"`+base64.StdEncoding.EncodeToString(KeyOf(filepath.Join(lib, other.ExtID, "2.2.0")))+`"}`)
	own, err := InstallDir(lib, src, keyFor)
	if err != nil || own.ExtID != other.ExtID || asked != "" {
		t.Fatalf("源带密钥：%+v %v（不该问：%q）", own, err, asked)
	}
}
