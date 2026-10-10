package i18n

import "testing"

func TestTLangSupportsItalian(t *testing.T) {
	if got, want := TLang("it", MsgInvalidRequest), "Richiesta non valida"; got != want {
		t.Fatalf("TLang() = %q, want %q", got, want)
	}

	if got, want := TLang("it", MsgVideoNotFound, 42), "Video con ID 42 non trovato"; got != want {
		t.Fatalf("TLang() with arguments = %q, want %q", got, want)
	}
}

func TestResolveCodeNormalizesSupportedLanguages(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "zh-CN", want: "zh"},
		{input: "it-IT", want: "it"},
		{input: "en-US", want: "en"},
		{input: "system", want: DefaultLang},
		{input: "unsupported", want: DefaultLang},
	}

	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			if got := resolveCode(test.input); got != test.want {
				t.Fatalf("resolveCode(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}
