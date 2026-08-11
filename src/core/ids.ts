import { randomUUID } from "node:crypto";

export type Uuid = string;
export const newUuid = (): Uuid => randomUUID();
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
