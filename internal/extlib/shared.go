package extlib

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 主数据布局：<masterDir>/current/d<i>/ 对应 KernelAdapter.ExtDataDirs 返回的第 i 个目录；
// 被覆盖的旧主数据改名为 <masterDir>/backup-<毫秒时间戳>/，保留最近若干份。

func slot(masterDir string, i int) string {
	return filepath.Join(masterDir, "current", fmt.Sprintf("d%d", i))
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !info.Mode().IsRegular() || info.Name() == "LOCK" {
			return nil
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		return err
	})
}

// HasMaster 是否已有主数据。
func HasMaster(masterDir string) bool {
	_, err := os.Stat(filepath.Join(masterDir, "current"))
	return err == nil
}

// Pull 用主数据整体替换实例里该扩展的数据目录。没有主数据时什么都不做（实例保留自己的数据）。
// 只能在该实例的浏览器进程完全退出后调用。
func Pull(masterDir string, dirs []string) error {
	if !HasMaster(masterDir) {
		return nil
	}
	for i, d := range dirs {
		src := slot(masterDir, i)
		if _, err := os.Stat(src); err != nil {
			if err := os.RemoveAll(d); err != nil {
				return err
			}
			continue
		}
		tmp := d + ".masktab-tmp"
		_ = os.RemoveAll(tmp)
		if err := os.MkdirAll(filepath.Dir(d), 0o755); err != nil {
			return err
		}
		if err := copyDir(src, tmp); err != nil { // 先复制到临时目录再改名，中途失败不留半份数据
			_ = os.RemoveAll(tmp)
			return err
		}
		if err := os.RemoveAll(d); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		if err := os.Rename(tmp, d); err != nil {
			return err
		}
	}
	return nil
}

// Push 把实例里该扩展的数据整体复制为新的主数据；旧主数据转为备份，最多保留 keep 份。
func Push(masterDir string, dirs []string, keep int) error {
	if err := os.MkdirAll(masterDir, 0o755); err != nil {
		return err
	}
	inc := filepath.Join(masterDir, "incoming")
	_ = os.RemoveAll(inc)
	if err := os.MkdirAll(inc, 0o755); err != nil {
		return err
	}
	for i, d := range dirs {
		if _, err := os.Stat(d); err != nil {
			continue
		}
		if err := copyDir(d, filepath.Join(inc, fmt.Sprintf("d%d", i))); err != nil {
			_ = os.RemoveAll(inc)
			return err
		}
	}
	cur := filepath.Join(masterDir, "current")
	if _, err := os.Stat(cur); err == nil {
		if err := os.Rename(cur, backupName(masterDir)); err != nil {
			return err
		}
	}
	if err := os.Rename(inc, cur); err != nil {
		return err
	}
	bk := Backups(masterDir)
	for i := keep; i < len(bk); i++ {
		_ = os.RemoveAll(filepath.Join(masterDir, bk[i]))
	}
	return nil
}

// backupName 生成一个不重名、按字典序递增的备份目录名。
func backupName(masterDir string) string {
	ts := time.Now().UnixMilli()
	if bk := Backups(masterDir); len(bk) > 0 {
		var last int64
		fmt.Sscanf(bk[0], "backup-%d", &last)
		if ts <= last {
			ts = last + 1
		}
	}
	return filepath.Join(masterDir, fmt.Sprintf("backup-%013d", ts))
}

// Backups 返回备份目录名，新的在前。
func Backups(masterDir string) []string {
	ents, _ := os.ReadDir(masterDir)
	var out []string
	for _, e := range ents {
		if e.IsDir() && strings.HasPrefix(e.Name(), "backup-") {
			out = append(out, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out
}

// Rollback 把某份备份恢复为主数据（当前主数据转为备份）。
func Rollback(masterDir, backup string) error {
	src := filepath.Join(masterDir, filepath.Base(backup))
	if _, err := os.Stat(src); err != nil || !strings.HasPrefix(filepath.Base(backup), "backup-") {
		return fmt.Errorf("备份不存在：%s", backup)
	}
	cur := filepath.Join(masterDir, "current")
	tmp := filepath.Join(masterDir, "rollback-tmp")
	if err := os.Rename(src, tmp); err != nil {
		return err
	}
	if _, err := os.Stat(cur); err == nil {
		if err := os.Rename(cur, backupName(masterDir)); err != nil {
			return err
		}
	}
	return os.Rename(tmp, cur)
}

// volatile 是 LevelDB 每次打开都会变、但不代表数据变化的文件。
var volatile = map[string]bool{"LOCK": true, "LOG": true, "LOG.old": true}

// Hash 计算一组目录的内容哈希，用于判断"本次运行是否改过数据"。
// 已知局限（见 docs/PROGRESS.md）：这是文件级比较；LevelDB 在没有逻辑写入时也可能重写文件，
// 那样会被误判为"改过"而多推一次。
func Hash(dirs []string) string {
	h := sha1.New()
	for i, d := range dirs {
		var files []string
		_ = filepath.Walk(d, func(p string, info os.FileInfo, err error) error {
			if err == nil && info.Mode().IsRegular() && !volatile[info.Name()] {
				files = append(files, p)
			}
			return nil
		})
		sort.Strings(files)
		for _, f := range files {
			rel, _ := filepath.Rel(d, f)
			fmt.Fprintf(h, "%d/%s\n", i, filepath.ToSlash(rel))
			if in, err := os.Open(f); err == nil {
				_, _ = io.Copy(h, in)
				in.Close()
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
