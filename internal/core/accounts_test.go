package core

import (
	"testing"

	"github.com/halou367/masktab/internal/model"
)

func TestReorder(t *testing.T) {
	l := []*model.Instance{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "d"}}
	got := reorder(l, []string{"c", "a"})
	want := "cabd"
	s := ""
	for _, x := range got {
		s += x.ID
	}
	if s != want {
		t.Fatalf("got %s want %s", s, want)
	}
}

func TestEmailOf(t *testing.T) {
	if emailOf(&model.Instance{Name: "a@b.com"}) != "a@b.com" || emailOf(&model.Instance{Name: "工作号"}) != "" {
		t.Fatal("emailOf")
	}
}
