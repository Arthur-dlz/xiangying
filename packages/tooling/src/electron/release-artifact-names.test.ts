import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const buildSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "build.ts"),
  "utf8",
);

test("decouples public artifact names from the installed product name", () => {
  expect(buildSource).toContain('productName: "乡映"');
  expect(buildSource).toContain(
    '"xiangying-setup-${platform}-${arch}-${buildVersion}.${ext}"',
  );
  expect(buildSource).toContain(
    '"xiangying-portable-${platform}-${arch}-${buildVersion}.${ext}"',
  );
  expect(buildSource).not.toContain(
    '"${productName}-setup-${platform}-${arch}-${buildVersion}.${ext}"',
  );
  expect(buildSource).not.toContain(
    '"${productName}-portable-${platform}-${arch}-${buildVersion}.${ext}"',
  );
});

test("does not post-process completed NSIS installers", () => {
  expect(buildSource).not.toContain("artifactBuildCompleted");
  expect(buildSource).not.toContain("rcedit");
});
