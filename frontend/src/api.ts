// Typed wrappers over host.invokeBackend for VM-Poppy's backend routes.

import { host } from "./host";
import type { InstallState, Meta, PackageOutcome, VmConfig, VmSummary } from "./types";

export const api = {
  meta: () => host.invokeBackend<Meta>({ method: "GET", path: "/meta" }),

  listConfigs: () => host.invokeBackend<{ configs: VmConfig[] }>({ method: "GET", path: "/configs" }),
  saveConfig: (config: VmConfig) =>
    host.invokeBackend<{ configs: VmConfig[] }>({ method: "POST", path: "/configs", body: { config } }),
  deleteConfig: (id: string) =>
    host.invokeBackend<{ configs: VmConfig[] }>({ method: "DELETE", path: `/configs/${id}` }),

  listVms: () => host.invokeBackend<{ vms: VmSummary[] }>({ method: "GET", path: "/vms" }),
  launch: (config: VmConfig) =>
    host.invokeBackend<{ vm: VmSummary }>({ method: "POST", path: "/vms/launch", body: { config } }),
  installState: (id: string) =>
    host.invokeBackend<{ state: InstallState; packages?: PackageOutcome[] }>({ method: "GET", path: `/vms/${id}/install` }),
  windowsPassword: (id: string) =>
    host.invokeBackend<{ ready: boolean; password?: string }>({ method: "GET", path: `/vms/${id}/password` }),
  privateKey: (id: string, keyName: string) =>
    host.invokeBackend<{ keyName: string; pem: string }>({
      method: "GET",
      path: `/vms/${id}/key?keyName=${encodeURIComponent(keyName)}`,
    }),
  stop: (id: string) => host.invokeBackend<{ ok: true }>({ method: "POST", path: `/vms/${id}/stop` }),
  start: (id: string) => host.invokeBackend<{ ok: true }>({ method: "POST", path: `/vms/${id}/start` }),
  terminate: (id: string) => host.invokeBackend<{ ok: true }>({ method: "POST", path: `/vms/${id}/terminate` }),
};
