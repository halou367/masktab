package companion

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestIDMatchesKey(t *testing.T) {
	b, err := FS.ReadFile("ext/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct{ Key string }
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	der, err := base64.StdEncoding.DecodeString(m.Key)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	id := make([]byte, 32)
	for i, c := range sum[:16] {
		id[2*i], id[2*i+1] = 'a'+c>>4, 'a'+c&15
	}
	if string(id) != ID {
		t.Fatalf("manifest 的 key 对应 ID %s，与常量 %s 不一致", id, ID)
	}
}
