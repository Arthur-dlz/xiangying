import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const footerPath = fileURLToPath(new URL("./Footer.vue", import.meta.url));

describe("documentation footer", () => {
  it("uses a compact utility footer on article pages", () => {
    const footerSource = readFileSync(footerPath, "utf8");

    expect(footerSource).toContain("const { frontmatter, lang } = useData()");
    expect(footerSource).toContain(
      'const isHome = computed(() => frontmatter.value.layout === "home")',
    );
    expect(footerSource).toContain('v-if="isHome"');
    expect(footerSource).toContain('class="docs-footer__article"');
    expect(footerSource).toContain("Copyright ©");
    expect(footerSource).toContain("豫ICP备20012967号-2");
  });
});
