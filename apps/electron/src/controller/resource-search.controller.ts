import { provide } from "@inversifyjs/binding-decorators";
import { type Controller, IPC, type ResourceProvider } from "@mediago/common";
import type { IpcMainEvent } from "electron";
import { inject, injectable } from "inversify";
import { handle } from "../core/decorators";
import { ResourceSearchService } from "../services/resource-search.service";
import { TYPES } from "../types/symbols";

@injectable()
@provide(TYPES.Controller)
export default class ResourceSearchController implements Controller {
  constructor(
    @inject(ResourceSearchService)
    private readonly resourceSearch: ResourceSearchService,
  ) {}
  @handle(IPC.resourceSearch.listProviders)
  listProviders(_event: IpcMainEvent) {
    return this.resourceSearch.listProviders();
  }
  @handle(IPC.resourceSearch.saveProviders)
  saveProviders(_event: IpcMainEvent, providers: ResourceProvider[]) {
    return this.resourceSearch.saveProviders(providers);
  }
  @handle(IPC.resourceSearch.search)
  search(_event: IpcMainEvent, keyword: string, page?: number) {
    return this.resourceSearch.search(keyword, page);
  }
  @handle(IPC.resourceSearch.cancel)
  cancel(_event: IpcMainEvent) {
    return this.resourceSearch.cancel();
  }
}
