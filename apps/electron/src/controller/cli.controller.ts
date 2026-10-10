import { provide } from "@inversifyjs/binding-decorators";
import {
  type CLIInstallOptions,
  type CLIInstallStatus,
  type Controller,
  IPC,
} from "@mediago/common";
import { inject, injectable } from "inversify";
import { handle } from "../core/decorators";
import { CLIInstaller } from "../services/cli-installer";
import { TYPES } from "../types/symbols";

@injectable()
@provide(TYPES.Controller)
export default class CLIController implements Controller {
  constructor(
    @inject(CLIInstaller)
    private readonly installer: CLIInstaller,
  ) {}

  @handle(IPC.cli.getStatus)
  getStatus(): Promise<CLIInstallStatus> {
    return this.installer.getStatus();
  }

  @handle(IPC.cli.install)
  install(
    _event: Electron.IpcMainInvokeEvent,
    options: CLIInstallOptions,
  ): Promise<CLIInstallStatus> {
    return this.installer.install(options);
  }
}
