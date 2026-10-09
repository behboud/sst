package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAzureNativeSDKIsIncludedInExtractedPlatform(t *testing.T) {
	dir := t.TempDir()
	if err := CopyTo(".", dir); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		t.Fatal(err)
	}
	if got := pkg.Dependencies["@pulumi/azure-native"]; got != "3.28.0" {
		t.Fatalf("extracted Azure Native SDK version = %q, want 3.28.0", got)
	}
}
