// lib/store.ts: a JSON file standing in for your database (Node runtime only)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type FileRecord = {
  key: string; owner: string; size: number; contentType: string; fileName: string | null;
  visibility: "public" | "private"; url: string | null; createdAt: string;
};
const FILE = path.join(process.cwd(), ".data", "files.json");

async function load(): Promise<FileRecord[]> {
  try { return JSON.parse(await readFile(FILE, "utf8")) as FileRecord[]; } catch { return []; }
}
async function save(rows: FileRecord[]) {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2));
}
/** Upsert on key: onConfirmed is at-least-once. */
export async function upsertFile(record: FileRecord) {
  const rows = await load();
  const i = rows.findIndex((r) => r.key === record.key);
  if (i >= 0) rows[i] = record; else rows.push(record);
  await save(rows);
}
export async function listFiles(owner: string) {
  return (await load()).filter((r) => r.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getFile(key: string) { return (await load()).find((r) => r.key === key) ?? null; }
export async function removeFile(key: string) { await save((await load()).filter((r) => r.key !== key)); }
