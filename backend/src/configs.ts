// Local persistence for saved VM configs and generated SSH key pairs.
//
// Configs are user preferences, NOT cloud state (live VM state is always read from
// EC2). They live under ~/.vmpoppy so nothing extra is provisioned in AWS. Private
// keys we generate for SSH/Windows-password are written here too, 0600, and never
// leave the machine. See DESIGN.md §8, §9.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VmConfig } from "./types";

const HOME = process.env.VMPOPPY_HOME || join(homedir(), ".vmpoppy");
const CONFIGS_FILE = join(HOME, "configs.json");
const KEYS_DIR = join(HOME, "keys");

function ensureHome(): void {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });
}

export function listConfigs(): VmConfig[] {
  if (!existsSync(CONFIGS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(CONFIGS_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as VmConfig[]) : [];
  } catch {
    return [];
  }
}

export function saveConfig(config: VmConfig): VmConfig[] {
  ensureHome();
  const all = listConfigs().filter((c) => c.id !== config.id);
  all.push(config);
  writeFileSync(CONFIGS_FILE, JSON.stringify(all, null, 2));
  return all;
}

export function deleteConfig(id: string): VmConfig[] {
  ensureHome();
  const all = listConfigs().filter((c) => c.id !== id);
  writeFileSync(CONFIGS_FILE, JSON.stringify(all, null, 2));
  return all;
}

/** Store a generated private key (PEM). Returns the on-disk path. */
export function savePrivateKey(keyName: string, pem: string): string {
  ensureHome();
  const path = join(KEYS_DIR, `${keyName}.pem`);
  writeFileSync(path, pem);
  chmodSync(path, 0o600);
  return path;
}

export function privateKeyPath(keyName: string): string {
  return join(KEYS_DIR, `${keyName}.pem`);
}

export function readPrivateKey(keyName: string): string | null {
  const path = privateKeyPath(keyName);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
