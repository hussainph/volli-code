/**
 * The migration export worker's entry module: what a host bundles as its own
 * entry point and hands to `runMigrationExportInWorker` (see `worker.ts`).
 */
import { serveMigrationExportWorker } from "./worker";

serveMigrationExportWorker();
