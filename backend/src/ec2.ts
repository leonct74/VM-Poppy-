// The EC2 service — all AWS mutations VM-Poppy makes. Everything it creates is
// stamped with the three attribution tags at creation, and every change/delete is
// naturally limited to our own tagged resources by the broker's session policy.
// See DESIGN.md §4–§8.

import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  CreateKeyPairCommand,
  DeleteKeyPairCommand,
  DescribeImagesCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  GetConsoleOutputCommand,
  GetPasswordDataCommand,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { privateDecrypt, constants as cryptoConstants } from "node:crypto";
import { resolveAmi } from "./amis";
import { attributionTags, ownInstancesFilter, tagValue, TAG_CONFIG, TAG_NAME, TAG_LIFECYCLE, TAG_USER, TAG_PLATFORM, TAG_APP, TAG_CONNECTION, APP_ID } from "./tags";
import { savePrivateKey, readPrivateKey } from "./configs";
import { generateUserData } from "./userdata";
import { detectPublicIp } from "./publicIp";
import { INSTALL_SENTINEL, loginUser, type VmConfig, type VmSummary, type IngressRule, type InstallState } from "./types";

export interface Ec2Context {
  accountId: string;
  connectionId: string;
  region: string;
}

function shortId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Robust OS detection. Our own `vmpoppy:platform` tag is authoritative when present
 * (we stamp it at launch). Otherwise fall back to EC2's fields — and note the trap
 * this fixes: the legacy `Platform` field returns lowercase "windows" ON THE WIRE even
 * though the SDK TYPES it "Windows", so a `=== "Windows"` check passes tsc but fails at
 * runtime, mislabelling Windows boxes as Linux. Compare case-insensitively, and use
 * `PlatformDetails` (contains "Windows") as a second signal.
 */
export function detectPlatform(inst: {
  Platform?: string;
  PlatformDetails?: string;
  Tags?: { Key?: string; Value?: string }[];
}): "linux" | "windows" {
  const tag = tagValue(inst.Tags, TAG_PLATFORM);
  if (tag === "windows" || tag === "linux") return tag;
  const isWindows = (inst.Platform ?? "").toLowerCase() === "windows" || /windows/i.test(inst.PlatformDetails ?? "");
  return isWindows ? "windows" : "linux";
}

export class Ec2Service {
  constructor(private readonly ec2: EC2Client, private readonly ctx: Ec2Context) {}

  private attrTags() {
    return attributionTags({ accountId: this.ctx.accountId, connectionId: this.ctx.connectionId });
  }

  // ---- Launch --------------------------------------------------------------

  async launch(config: VmConfig): Promise<VmSummary> {
    const imageId = config.amiId ?? (await resolveAmi(this.ec2, config.os, config.arch));
    const rootDeviceName = await this.rootDeviceName(imageId);
    const vpcId = await this.resolveVpcId(config.subnetId);
    const keyName = `vmpoppy-${shortId()}`;
    const securityGroupId = await this.createSecurityGroup(config, vpcId, keyName);
    await this.createKeyPair(keyName);

    const userData = generateUserData({ config });
    const nameTag = config.name || "VM-Poppy instance";
    const resourceTags = [
      ...this.attrTags(),
      { Key: TAG_NAME, Value: nameTag },
      { Key: TAG_CONFIG, Value: config.id },
      { Key: TAG_LIFECYCLE, Value: config.lifecycle },
      { Key: TAG_USER, Value: loginUser(config.os, config.platform) },
      { Key: TAG_PLATFORM, Value: config.platform },
      ...Object.entries(config.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    ];

    const res = await this.ec2.send(
      new RunInstancesCommand({
        ImageId: imageId,
        InstanceType: config.instanceType as _InstanceType,
        MinCount: 1,
        MaxCount: 1,
        KeyName: keyName,
        SecurityGroupIds: [securityGroupId],
        ...(config.subnetId ? { SubnetId: config.subnetId } : {}),
        UserData: Buffer.from(userData, "utf8").toString("base64"),
        InstanceInitiatedShutdownBehavior: config.lifecycle === "ephemeral" ? "terminate" : "stop",
        BlockDeviceMappings: [
          {
            DeviceName: rootDeviceName,
            Ebs: { VolumeSize: config.diskGb, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
          },
        ],
        ...(config.purchasing === "spot"
          ? { InstanceMarketOptions: { MarketType: "spot", SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" } } }
          : {}),
        TagSpecifications: [
          { ResourceType: "instance", Tags: resourceTags },
          { ResourceType: "volume", Tags: resourceTags },
        ],
      }),
    );

    const inst = res.Instances?.[0];
    if (!inst?.InstanceId) throw new Error("EC2 did not return a launched instance.");
    return this.toSummary(inst, config.platform);
  }

  private async rootDeviceName(imageId: string): Promise<string> {
    const res = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
    return res.Images?.[0]?.RootDeviceName ?? "/dev/xvda";
  }

  private async resolveVpcId(subnetId?: string): Promise<string> {
    if (subnetId) {
      const res = await this.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
      const vpc = res.Subnets?.[0]?.VpcId;
      if (!vpc) throw new Error(`Subnet ${subnetId} not found.`);
      return vpc;
    }
    const res = await this.ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }));
    const vpc = res.Vpcs?.[0]?.VpcId;
    if (!vpc) throw new Error("No default VPC in this region. Pick a subnet in PRO mode.");
    return vpc;
  }

  private async createSecurityGroup(config: VmConfig, vpcId: string, keyName: string): Promise<string> {
    const res = await this.ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: `vmpoppy-${keyName}`,
        Description: `VM-Poppy security group for ${config.name}`,
        VpcId: vpcId,
        TagSpecifications: [{ ResourceType: "security-group", Tags: [...this.attrTags(), { Key: TAG_NAME, Value: config.name }] }],
      }),
    );
    const sgId = res.GroupId;
    if (!sgId) throw new Error("Failed to create security group.");

    const rules = await this.ingressRules(config);
    if (rules.length > 0) {
      await this.ec2.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpPermissions: rules.map((r) => ({
            IpProtocol: r.protocol,
            FromPort: r.fromPort,
            ToPort: r.toPort,
            IpRanges: [{ CidrIp: r.cidr, Description: "VM-Poppy" }],
          })),
        }),
      );
    }

    // Detonation mode: drop the default allow-all egress rule.
    if (config.restrictEgress) {
      await this.ec2
        .send(new RevokeSecurityGroupEgressCommand({ GroupId: sgId, IpPermissions: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] }))
        .catch(() => undefined);
    }
    return sgId;
  }

  private async ingressRules(config: VmConfig): Promise<IngressRule[]> {
    const myIp = async () => {
      const ip = await detectPublicIp();
      if (!ip) throw new Error("Couldn't detect your public IP to open the firewall. Use a custom rule in PRO mode.");
      return `${ip}/32`;
    };
    switch (config.access) {
      case "airgapped":
        return [];
      case "ssh-my-ip":
        return [{ protocol: "tcp", fromPort: 22, toPort: 22, cidr: await myIp() }];
      case "rdp-my-ip":
        return [{ protocol: "tcp", fromPort: 3389, toPort: 3389, cidr: await myIp() }];
      case "custom": {
        const out: IngressRule[] = [];
        for (const r of config.ingress ?? []) out.push({ ...r, cidr: r.cidr === "my-ip" ? await myIp() : r.cidr });
        return out;
      }
    }
  }

  private async createKeyPair(keyName: string): Promise<void> {
    const res = await this.ec2.send(
      new CreateKeyPairCommand({
        KeyName: keyName,
        KeyType: "rsa",
        TagSpecifications: [{ ResourceType: "key-pair", Tags: this.attrTags() }],
      }),
    );
    if (!res.KeyMaterial) throw new Error("EC2 did not return key material.");
    savePrivateKey(keyName, res.KeyMaterial);
  }

  // ---- List / state --------------------------------------------------------

  async listVms(): Promise<VmSummary[]> {
    const res = await this.ec2.send(
      new DescribeInstancesCommand({ Filters: ownInstancesFilter({ accountId: this.ctx.accountId, connectionId: this.ctx.connectionId }) }),
    );
    const out: VmSummary[] = [];
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        if ((inst.State?.Name ?? "") === "terminated") continue;
        out.push(this.toSummary(inst, detectPlatform(inst)));
      }
    }
    return out.sort((a, b) => (b.launchedAt ?? "").localeCompare(a.launchedAt ?? ""));
  }

  /** True install state for one running instance (heavier — polled on demand). */
  async installState(instanceId: string): Promise<InstallState> {
    const inst = await this.getOwnInstance(instanceId);
    const state = inst.State?.Name ?? "";
    if (state === "pending") return "booting";
    if (state !== "running") return "unknown";
    const platform = detectPlatform(inst);
    if (platform === "windows") {
      const res = await this.ec2.send(new GetPasswordDataCommand({ InstanceId: instanceId })).catch(() => null);
      return res?.PasswordData ? "ready" : "installing";
    }
    const res = await this.ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true })).catch(() => null);
    const text = res?.Output ? Buffer.from(res.Output, "base64").toString("utf8") : "";
    return text.includes(INSTALL_SENTINEL) ? "ready" : "installing";
  }

  // ---- Lifecycle -----------------------------------------------------------

  async stop(instanceId: string): Promise<void> {
    await this.getOwnInstance(instanceId); // authorize: must be ours
    await this.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async start(instanceId: string): Promise<void> {
    await this.getOwnInstance(instanceId);
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async terminate(instanceId: string): Promise<void> {
    const inst = await this.getOwnInstance(instanceId);
    await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    // Best-effort: clean the per-instance SG + key pair once it's gone.
    const sgId = inst.SecurityGroups?.[0]?.GroupId;
    const keyName = inst.KeyName;
    void this.cleanupAfterTerminate(sgId, keyName);
  }

  private async cleanupAfterTerminate(sgId?: string, keyName?: string): Promise<void> {
    // Give termination a moment so the SG is no longer in use; ignore failures
    // (the teardown hook is the real guarantee).
    await new Promise((r) => setTimeout(r, 4000));
    if (sgId) await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: sgId })).catch(() => undefined);
    if (keyName) await this.ec2.send(new DeleteKeyPairCommand({ KeyName: keyName })).catch(() => undefined);
  }

  // ---- Windows password / key download ------------------------------------

  async windowsPassword(instanceId: string): Promise<string> {
    const inst = await this.getOwnInstance(instanceId);
    if (detectPlatform(inst) !== "windows") throw new Error("This is not a Windows instance.");
    const res = await this.ec2.send(new GetPasswordDataCommand({ InstanceId: instanceId }));
    if (!res.PasswordData) throw new Error("The Windows password isn't ready yet (it can take a few minutes after launch).");
    const pem = inst.KeyName ? readPrivateKey(inst.KeyName) : null;
    if (!pem) throw new Error("The key for this instance isn't on this machine, so the password can't be decrypted.");
    return decryptWindowsPassword(pem, res.PasswordData);
  }

  getPrivateKey(keyName: string): string | null {
    return readPrivateKey(keyName);
  }

  // ---- Teardown hook (the real leave-no-trace guarantee for EC2) -----------

  async teardown(): Promise<{ terminated: string[]; securityGroups: string[]; keyPairs: string[] }> {
    const instances = await this.listOwnInstancesRaw();
    const instanceIds = instances.map((i) => i.InstanceId!).filter(Boolean);
    const sgIds = new Set<string>();
    const keyNames = new Set<string>();
    for (const i of instances) {
      for (const sg of i.SecurityGroups ?? []) if (sg.GroupId) sgIds.add(sg.GroupId);
      if (i.KeyName) keyNames.add(i.KeyName);
    }

    if (instanceIds.length > 0) {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
      await this.waitTerminated(instanceIds);
    }

    // Also sweep any of our tagged SGs not attached to a listed instance.
    const taggedSgs = await this.ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: `tag:${TAG_APP}`, Values: [APP_ID] }, { Name: `tag:${TAG_CONNECTION}`, Values: [this.ctx.connectionId] }] }),
    );
    for (const sg of taggedSgs.SecurityGroups ?? []) if (sg.GroupId) sgIds.add(sg.GroupId);

    const deletedSgs: string[] = [];
    for (const id of sgIds) {
      const ok = await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: id })).then(() => true).catch(() => false);
      if (ok) deletedSgs.push(id);
    }
    const deletedKeys: string[] = [];
    for (const name of keyNames) {
      const ok = await this.ec2.send(new DeleteKeyPairCommand({ KeyName: name })).then(() => true).catch(() => false);
      if (ok) deletedKeys.push(name);
    }
    return { terminated: instanceIds, securityGroups: deletedSgs, keyPairs: deletedKeys };
  }

  private async waitTerminated(instanceIds: string[]): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
      const states = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((x) => x.State?.Name);
      if (states.every((s) => s === "terminated")) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ---- helpers -------------------------------------------------------------

  private async listOwnInstancesRaw() {
    const res = await this.ec2.send(
      new DescribeInstancesCommand({ Filters: ownInstancesFilter({ accountId: this.ctx.accountId, connectionId: this.ctx.connectionId }) }),
    );
    return (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).filter((i) => (i.State?.Name ?? "") !== "terminated");
  }

  /** Fetch one instance and CONFIRM it is ours (tag match) before acting on it. */
  private async getOwnInstance(instanceId: string) {
    const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])[0];
    if (!inst) throw new Error(`Instance ${instanceId} not found.`);
    const app = tagValue(inst.Tags, TAG_APP);
    const conn = tagValue(inst.Tags, TAG_CONNECTION);
    if (app !== APP_ID || conn !== this.ctx.connectionId) {
      throw new Error("That instance isn't one VM-Poppy created for this connection.");
    }
    return inst;
  }

  private toSummary(inst: { InstanceId?: string; State?: { Name?: string }; InstanceType?: string; PublicIpAddress?: string; PublicDnsName?: string; LaunchTime?: Date; Tags?: { Key?: string; Value?: string }[]; KeyName?: string }, platform: "linux" | "windows"): VmSummary {
    const state = inst.State?.Name ?? "unknown";
    const lifecycle = (tagValue(inst.Tags, TAG_LIFECYCLE) as "reusable" | "ephemeral") ?? "reusable";
    const install: InstallState = state === "pending" ? "booting" : state === "running" ? "installing" : "unknown";
    return {
      instanceId: inst.InstanceId ?? "",
      name: tagValue(inst.Tags, TAG_NAME) ?? "VM-Poppy instance",
      configId: tagValue(inst.Tags, TAG_CONFIG),
      platform,
      state,
      instanceType: inst.InstanceType ?? "",
      publicIp: inst.PublicIpAddress,
      publicDns: inst.PublicDnsName,
      launchedAt: inst.LaunchTime ? new Date(inst.LaunchTime).toISOString() : undefined,
      lifecycle,
      install,
      keyName: inst.KeyName,
      user: tagValue(inst.Tags, TAG_USER),
    };
  }
}

/** Decrypt an EC2 Windows password (base64 PKCS1v1.5) with the instance's RSA private key. */
export function decryptWindowsPassword(privateKeyPem: string, passwordDataB64: string): string {
  const decrypted = privateDecrypt(
    { key: privateKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(passwordDataB64, "base64"),
  );
  return decrypted.toString("utf8");
}
