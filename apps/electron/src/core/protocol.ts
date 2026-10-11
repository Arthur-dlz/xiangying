import path, { join } from "node:path";
import { URL } from "node:url";
import { provide } from "@inversifyjs/binding-decorators";
import { app, protocol } from "electron";
import isDev from "electron-is-dev";
import { access, readFile } from "node:fs/promises";
import { injectable } from "inversify";
import mime from "mime-types";
import { defaultScheme } from "../utils";

@injectable()
@provide()
export default class ProtocolService {
  create(): void {
    if (isDev) return;

    protocol.handle(defaultScheme, async (req) => {
      const pathName = new URL(req.url).pathname;
      const rendererDir = join(__dirname, "../renderer");
      const resolved = path.resolve(rendererDir, `.${pathName}`);
      let filePath =
        resolved === rendererDir || resolved.startsWith(rendererDir + path.sep)
          ? resolved
          : join(rendererDir, "index.html");
      try {
        await access(filePath);
      } catch {
        filePath = join(rendererDir, "index.html");
      }
      try {
        const mimeType = mime.lookup(filePath);
        const data = await readFile(filePath);
        return new Response(data, {
          headers: { "Content-Type": mimeType || "text/html" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    });
  }
}
