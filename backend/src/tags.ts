// Attribution tags — the three keys AgentsPoppy uses for scoping + teardown.
// Every resource VM-Poppy creates MUST carry all three, stamped at creation, or it
// becomes (a) invisible to the host's tag sweep and (b) un-mutatable by our own
// tag-scoped credentials. See DESIGN.md §5.

export const APP_ID = "com.vmpoppy.desktop";

export const TAG_ACCOUNT = "agentspoppy:account";
export const TAG_APP = "agentspoppy:app";
export const TAG_CONNECTION = "agentspoppy:connection";

/** Optional VM-Poppy-local tags for our own bookkeeping (also swept + torn down). */
export const TAG_CONFIG = "vmpoppy:config";
export const TAG_NAME = "vmpoppy:name";
export const TAG_LIFECYCLE = "vmpoppy:lifecycle";
export const TAG_USER = "vmpoppy:user";

export interface AttributionContext {
  accountId: string;
  connectionId: string;
}

/** The three required attribution tags as an EC2 Tag[] array. */
export function attributionTags(ctx: AttributionContext): { Key: string; Value: string }[] {
  return [
    { Key: TAG_ACCOUNT, Value: ctx.accountId },
    { Key: TAG_APP, Value: APP_ID },
    { Key: TAG_CONNECTION, Value: ctx.connectionId },
  ];
}

/** A DescribeInstances filter that returns ONLY this connection's own instances. */
export function ownInstancesFilter(ctx: AttributionContext): { Name: string; Values: string[] }[] {
  return [
    { Name: `tag:${TAG_APP}`, Values: [APP_ID] },
    { Name: `tag:${TAG_CONNECTION}`, Values: [ctx.connectionId] },
  ];
}

/** A tag:GetResources-style filter value for a whole-app sweep (teardown backstop). */
export function appSweepFilter(): { Name: string; Values: string[] } {
  return { Name: `tag:${TAG_APP}`, Values: [APP_ID] };
}

/** Read a tag value off an EC2 Tag[] (case-sensitive key). */
export function tagValue(
  tags: { Key?: string; Value?: string }[] | undefined,
  key: string,
): string | undefined {
  return tags?.find((t) => t.Key === key)?.Value;
}
