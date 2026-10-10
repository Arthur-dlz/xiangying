import { provide } from "@inversifyjs/binding-decorators";
import { type Controller, IPC, type LibraryItemPatch } from "@mediago/common";
import type { IpcMainEvent } from "electron";
import { inject, injectable } from "inversify";
import { handle } from "../core/decorators";
import { LibraryService } from "../services/library.service";
import { TYPES } from "../types/symbols";

@injectable()
@provide(TYPES.Controller)
export default class LibraryController implements Controller {
  constructor(
    @inject(LibraryService) private readonly library: LibraryService,
  ) {}

  @handle(IPC.library.list)
  list(_event: IpcMainEvent) {
    return this.library.list();
  }

  @handle(IPC.library.importFiles)
  importFiles(
    _event: IpcMainEvent,
    paths: string[],
    source?: "import" | "download",
  ) {
    return this.library.importFiles(paths, source);
  }

  @handle(IPC.library.update)
  update(_event: IpcMainEvent, id: string, patch: LibraryItemPatch) {
    return this.library.update(id, patch);
  }

  @handle(IPC.library.remove)
  remove(_event: IpcMainEvent, id: string) {
    return this.library.remove(id);
  }

  @handle(IPC.library.scan)
  scan(_event: IpcMainEvent, id: string) {
    return this.library.scan(id);
  }

  @handle(IPC.library.play)
  play(_event: IpcMainEvent, id: string) {
    return this.library.play(id);
  }

  @handle(IPC.library.reveal)
  reveal(_event: IpcMainEvent, id: string) {
    return this.library.reveal(id);
  }

  @handle(IPC.library.exportFiles)
  exportFiles(_event: IpcMainEvent, ids: string[]) {
    return this.library.exportFiles(ids);
  }
}
