import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { encrypt, decrypt } from "./crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");

export class EncryptedStorage {
  private encryptionKey: string;

  constructor(encryptionKey: string) {
    this.encryptionKey = encryptionKey;
    mkdirSync(DATA_DIR, { recursive: true });
  }

  save(sessionId: string, data: unknown): void {
    const json = JSON.stringify(data, null, 2);
    const encrypted = encrypt(json, this.encryptionKey);
    const filePath = resolve(DATA_DIR, `${sessionId}.enc`);
    writeFileSync(filePath, encrypted, "utf-8");
  }

  load<T>(sessionId: string): T | null {
    const filePath = resolve(DATA_DIR, `${sessionId}.enc`);
    if (!existsSync(filePath)) return null;

    const encrypted = readFileSync(filePath, "utf-8");
    const json = decrypt(encrypted, this.encryptionKey);
    return JSON.parse(json) as T;
  }
}
