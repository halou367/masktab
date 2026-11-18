package procs

import (
	"os"
	"syscall"
	"testing"
)

// 取内存的三条路在这台 Windows 上各自通不通（结果写进测试日志：CI 的机器比 Windows 11 老，正好看老系统走哪条）。
// 要求：至少“整个工作集”那条通；通的那些路给的专用工作集大于 0、不超过工作集；两条准的路都通时相差不大。
func TestMemPaths(t *testing.T) {
	h, err := syscall.OpenProcess(queryLimited|vmRead, false, uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	p1, w1, ok1 := memEx2(h)
	p2, w2, ok2 := memNt(h)
	w3, ok3 := memWS(h)
	t.Logf("memEx2 ok=%v 专用 %d 工作集 %d；memNt ok=%v 专用 %d 工作集 %d；memWS ok=%v 工作集 %d", ok1, p1, w1, ok2, p2, w2, ok3, w3)
	if !ok3 || w3 <= 0 {
		t.Fatalf("老结构应当一定走得通：ok=%v ws=%d", ok3, w3)
	}
	for name, v := range map[string][3]int64{"memEx2": {p1, w1, b2i(ok1)}, "memNt": {p2, w2, b2i(ok2)}} {
		if v[2] == 1 && (v[0] <= 0 || v[0] > v[1]) {
			t.Errorf("%s：专用工作集 %d 应当大于 0、不超过工作集 %d", name, v[0], v[1])
		}
	}
	if ok1 && ok2 {
		if d := p1 - p2; d > 8<<20 || d < -8<<20 {
			t.Errorf("两条路给的专用工作集差太多：%d 和 %d", p1, p2)
		}
	}
	mem, rough := memOf(h)
	t.Logf("memOf = %d rough=%v", mem, rough)
	if mem <= 0 || rough != !(ok1 || ok2) {
		t.Errorf("memOf = %d rough=%v（准的路 %v / %v）", mem, rough, ok1, ok2)
	}
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
