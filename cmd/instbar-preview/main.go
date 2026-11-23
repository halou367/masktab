//go:build js && wasm

// instbar-preview：把实例栏的排版和画法（internal/tabbar，Windows 上用的同一份）编成 WebAssembly，
// 给页面检查（scripts/check.sh pages 的 instbar 段，decisions UI-34）在浏览器里画出来、用真滚轮和鼠标去点。
// 只有画字是页面自己做的（Windows 上字由系统画）：字的位置照 paint_windows.go 的算法。
//
// 编：GOOS=js GOARCH=wasm go build -o instbar.wasm ./cmd/instbar-preview（check.sh pages 自己会编）
package main

import (
	"encoding/json"
	"math"
	"syscall/js"
	"time"

	"github.com/halou367/masktab/internal/tabbar"
)

type tabIn struct {
	Label string `json:"label"`
	Color [3]int `json:"color"`
}

var st struct {
	W      int
	Scale  float64
	Tabs   []tabIn
	Active int
	Bg     [3]int
	Sc     tabbar.Scroller
}

func lay() tabbar.Layout {
	return tabbar.LayCompact(st.W, len(st.Tabs), st.Active, st.Sc.Px(), st.Scale)
}

// reveal：和 paint_windows.go 的 repaintIfChanged 一样，当前的换了就把它滚到看得见。
func reveal(now bool) {
	l := lay()
	st.Sc.Clamp(l.Max)
	st.Sc.Goal = float64(l.Reveal(st.Active, int(math.Round(st.Sc.Goal)), st.Scale))
	if now {
		st.Sc.Pos = st.Sc.Goal
	}
}

func jsonOf(v any) js.Value {
	b, _ := json.Marshal(v)
	return js.ValueOf(string(b))
}

func paints(hover int, hoverX bool) []tabbar.TabPaint {
	out := make([]tabbar.TabPaint, len(st.Tabs))
	for i, t := range st.Tabs {
		out[i] = tabbar.TabPaint{Color: t.Color, Active: i == st.Active, Hover: i == hover, HoverX: i == hover && hoverX}
	}
	return out
}

func layoutInfo(l tabbar.Layout, e float64, ps []tabbar.TabPaint, lk tabbar.Look) map[string]any {
	strip := tabbar.Strip(l, st.Scale)
	var tabs []map[string]any
	for i, s := range l.Slots {
		r := tabbar.MorphRect(s.Tab, strip[i], e)
		tabs = append(tabs, map[string]any{"tab": s.Tab, "strip": strip[i], "now": r, "close": s.Close, "label": st.Tabs[i].Label,
			"ink": ps[i].Ink(lk), "active": ps[i].Active, "hover": ps[i].Hover})
	}
	return map[string]any{"tabs": tabs, "plus": l.Plus, "plusStrip": tabbar.PlusStrip(l, st.Scale), "view": l.View, "scroll": l.Scroll, "max": l.Max,
		"active": l.Active, "band": tabbar.Band(l, st.Scale), "ink": tabbar.InkAlpha(e), "e": e, "pos": st.Sc.Pos, "goal": st.Sc.Goal}
}

func main() {
	api := map[string]any{
		// setup({w, scale, tabs:[{label,color}], active, bg})
		"setup": js.FuncOf(func(_ js.Value, a []js.Value) any {
			var in struct {
				W      int     `json:"w"`
				Scale  float64 `json:"scale"`
				Tabs   []tabIn `json:"tabs"`
				Active int     `json:"active"`
				Bg     [3]int  `json:"bg"`
			}
			_ = json.Unmarshal([]byte(a[0].String()), &in)
			st.W, st.Scale, st.Tabs, st.Active, st.Bg = in.W, in.Scale, in.Tabs, in.Active, in.Bg
			st.Sc = tabbar.Scroller{}
			reveal(true)
			return nil
		}),
		"select": js.FuncOf(func(_ js.Value, a []js.Value) any { st.Active = a[0].Int(); reveal(false); return nil }),
		"wheel": js.FuncOf(func(_ js.Value, a []js.Value) any {
			return st.Sc.Wheel(a[0].Int(), a[1].Bool(), lay().Max, st.Scale)
		}),
		"step": js.FuncOf(func(_ js.Value, a []js.Value) any {
			return st.Sc.Step(time.Duration(a[0].Float() * float64(time.Millisecond)))
		}),
		"moving": js.FuncOf(func(_ js.Value, _ []js.Value) any { return st.Sc.Pos != st.Sc.Goal }),
		"hit": js.FuncOf(func(_ js.Value, a []js.Value) any {
			k, i := lay().Hit(a[0].Int(), a[1].Int())
			return js.ValueOf([]any{k, i})
		}),
		"stripHit": js.FuncOf(func(_ js.Value, a []js.Value) any { return tabbar.StripHit(lay(), a[0].Int(), st.Scale) }),
		"easeOut":  js.FuncOf(func(_ js.Value, a []js.Value) any { return tabbar.EaseOut(a[0].Float()) }),
		"easeShut": js.FuncOf(func(_ js.Value, a []js.Value) any { return tabbar.EaseShut(a[0].Float()) }),
		"hoverIn":  tabbar.HoverIn.Milliseconds(),
		"hoverOut": tabbar.HoverOut.Milliseconds(),
		"openH":    tabbar.OpenH,
		// render(e, hover, hoverX) → {pix: Uint8ClampedArray RGBA（预乘，没盖到底色上）, info: JSON}
		"render": js.FuncOf(func(_ js.Value, a []js.Value) any {
			e, hover, hoverX := a[0].Float(), a[1].Int(), a[2].Bool()
			l := lay()
			lk := tabbar.LookOn(st.Bg)
			ps := paints(hover, hoverX)
			c := tabbar.Morph(st.W, l, ps, lk, st.Scale, e, false)
			rgba := make([]byte, len(c.Pix))
			for i := 0; i < len(c.Pix); i += 4 {
				rgba[i], rgba[i+1], rgba[i+2], rgba[i+3] = c.Pix[i+2], c.Pix[i+1], c.Pix[i], c.Pix[i+3]
			}
			u8 := js.Global().Get("Uint8ClampedArray").New(len(rgba))
			js.CopyBytesToJS(js.Global().Get("Uint8Array").New(u8.Get("buffer")), rgba)
			o := js.Global().Get("Object").New()
			o.Set("pix", u8)
			o.Set("w", c.W)
			o.Set("h", c.H)
			o.Set("info", jsonOf(layoutInfo(l, e, ps, lk)))
			return o
		}),
		// fade(Uint8ClampedArray, w, h)：字画完以后两头渐隐（和 Windows 上一样，在字之后做）
		"fade": js.FuncOf(func(_ js.Value, a []js.Value) any {
			n := a[0].Get("length").Int()
			b := make([]byte, n)
			view := js.Global().Get("Uint8Array").New(a[0].Get("buffer"), a[0].Get("byteOffset"), n)
			js.CopyBytesToGo(b, view)
			tabbar.FadeEdges(b, a[1].Int(), a[2].Int(), lay(), st.Scale)
			js.CopyBytesToJS(view, b)
			return nil
		}),
		"info": js.FuncOf(func(_ js.Value, a []js.Value) any {
			return jsonOf(layoutInfo(lay(), a[0].Float(), paints(-1, false), tabbar.LookOn(st.Bg)))
		}),
	}
	js.Global().Set("instbar", js.ValueOf(api))
	js.Global().Call("dispatchEvent", js.Global().Get("Event").New("instbar"))
	select {}
}
