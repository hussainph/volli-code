/**
 * Opening the Volli database. The open, like every other operation that puts
 * a file at the database path, lives in the fenced database-file module
 * (`database-file.ts`, VC-628).
 */
export { assertDatabaseHeader, openVolliDb } from "./database-file";
