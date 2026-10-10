import { createPageActionController } from "./page-action-controller";
import { installPageActionContentScript } from "./lifecycle";

installPageActionContentScript(window, createPageActionController);
