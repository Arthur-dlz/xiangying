package schema

import (
	"slices"
	"testing"
)

func TestLoadSchemasFromJSONUsesBuiltInDefaultsForEmptyPath(t *testing.T) {
	loaded, err := LoadSchemasFromJSON("")
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultSchemas()
	if len(loaded.Schemas) != len(want.Schemas) {
		t.Fatalf("loaded %d schemas, want %d", len(loaded.Schemas), len(want.Schemas))
	}
}

func TestDirectSchemaDoesNotAllowOverwritingOutputs(t *testing.T) {
	direct, ok := DefaultSchemas().GetByType("direct")
	if !ok {
		t.Fatal("direct schema not found")
	}
	if slices.Contains(direct.Args["__common__"].ArgsName, "--allow-overwrite=true") {
		t.Fatal("direct schema allows aria2 to overwrite an existing output")
	}
}
