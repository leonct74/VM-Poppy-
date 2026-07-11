// Resolve a logical OS + architecture to a concrete AMI id, using ec2:DescribeImages
// (already in our permission set — no SSM grant needed). We filter by the image
// owner + a name pattern and pick the newest. See DESIGN.md §4.

import { DescribeImagesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import type { OsKey } from "./types";

interface ImageQuery {
  owners: string[];
  /** name filter; `${arch}` is substituted with the owner's arch token. */
  namePattern: string;
  /** How this owner names architectures in its AMI names. */
  archToken: (arch: "arm64" | "x86_64") => string;
  /** The EC2 `architecture` attribute value. */
  ec2Arch: (arch: "arm64" | "x86_64") => string;
}

const CANONICAL_OWNER = "099720109477"; // Canonical (Ubuntu)
const AMAZON_OWNER = "amazon";

const QUERIES: Record<OsKey, ImageQuery> = {
  "amazon-linux-2023": {
    owners: [AMAZON_OWNER],
    namePattern: "al2023-ami-2023.*-kernel-*-${arch}",
    archToken: (a) => a, // arm64 | x86_64
    ec2Arch: (a) => a,
  },
  "ubuntu-24.04": {
    owners: [CANONICAL_OWNER],
    namePattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${arch}-server-*",
    archToken: (a) => (a === "arm64" ? "arm64" : "amd64"),
    ec2Arch: (a) => a,
  },
  "windows-2022": {
    owners: [AMAZON_OWNER],
    namePattern: "Windows_Server-2022-English-Full-Base-*",
    archToken: () => "x86_64", // Windows Server AMIs here are x86_64
    ec2Arch: () => "x86_64",
  },
};

export async function resolveAmi(
  ec2: EC2Client,
  os: OsKey,
  arch: "arm64" | "x86_64",
): Promise<string> {
  const q = QUERIES[os];
  const name = q.namePattern.replace("${arch}", q.archToken(arch));
  const res = await ec2.send(
    new DescribeImagesCommand({
      Owners: q.owners,
      Filters: [
        { Name: "name", Values: [name] },
        { Name: "state", Values: ["available"] },
        { Name: "architecture", Values: [q.ec2Arch(arch)] },
        { Name: "root-device-type", Values: ["ebs"] },
        { Name: "virtualization-type", Values: ["hvm"] },
      ],
    }),
  );
  const images = (res.Images ?? [])
    .filter((i) => i.ImageId && i.CreationDate)
    .sort((a, b) => (b.CreationDate! < a.CreationDate! ? -1 : 1));
  const latest = images[0]?.ImageId;
  if (!latest) {
    throw new Error(`No ${os} (${arch}) AMI found in this region. You can enter a specific AMI id in PRO mode.`);
  }
  return latest;
}
