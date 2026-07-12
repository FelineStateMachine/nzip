import type { NotifyApprovalPreview, NotifyDeviceInfo, NotifyRequest } from "@nzip/shared";
import { ApiClient, resolveCliTarget } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { ago, bold, cyan, dim, emit, fail, green, table } from "../lib/fmt.ts";

export type NotifyInvocation =
  | { kind: "send"; body: string }
  | { kind: "test" }
  | { kind: "pair" }
  | { kind: "approve"; code: string }
  | { kind: "devices" }
  | { kind: "revoke"; deviceId: string };

export function parseNotifyInvocation(rest: string[]): NotifyInvocation {
  const [first, second, ...extra] = rest;
  if (!first) {
    fail("usage: nzip notify <send|test|pair|approve|devices|revoke> ...");
  }
  if (first === "test") {
    if (second !== undefined) fail("usage: nzip notify test");
    return { kind: "test" };
  }
  if (first === "pair") {
    if (second !== undefined) fail("usage: nzip notify pair");
    return { kind: "pair" };
  }
  if (first === "approve") {
    if (!second || extra.length > 0) fail("usage: nzip notify approve <code> --name NAME");
    return { kind: "approve", code: second };
  }
  if (first === "devices" || first === "ls") {
    if (second !== undefined) fail("usage: nzip notify devices");
    return { kind: "devices" };
  }
  if (first === "revoke") {
    if (!second || extra.length > 0) fail("usage: nzip notify revoke <device-id> [--yes]");
    return { kind: "revoke", deviceId: second };
  }
  if (first !== "send") {
    fail(`unknown notify command: ${first}`);
  }
  if (!second || extra.length > 0) {
    fail("usage: nzip notify send <body> [--title TEXT] [--open TARGET] [--tag TEXT]");
  }
  return { kind: "send", body: second };
}

function location(preview: NotifyApprovalPreview): string {
  return [preview.country, preview.region].filter(Boolean).join("/") || "unknown";
}

export function filterNotificationDevices(
  devices: NotifyDeviceInfo[],
  includeAll: boolean,
): NotifyDeviceInfo[] {
  if (includeAll) return devices;
  return devices.filter((device) =>
    device.status === "pending" || device.status === "approved" || device.status === "active"
  );
}

export async function cmdNotify(
  config: Config,
  rest: string[],
  options: {
    title?: string;
    open?: string;
    tag?: string;
    name?: string;
    yes: boolean;
    all: boolean;
  },
): Promise<void> {
  const invocation = parseNotifyInvocation(rest);
  const api = new ApiClient(config);

  if (invocation.kind === "pair") {
    const pairing = await api.openNotificationPairing();
    emit(
      () => console.log(`${green("✓")} pairing enabled for 10 minutes`),
      { ok: true, pairing },
    );
    return;
  }

  if (invocation.kind === "devices") {
    const devices = filterNotificationDevices(await api.notificationDevices(), options.all);
    emit(() => {
      if (devices.length === 0) return console.log(dim("no notification devices"));
      console.log(table(
        [
          "ID",
          "NAME",
          "STATUS",
          "CREATED",
          "APPROVED",
          "SEEN",
          "ATTACHED",
          "DELIVERED",
          "ERROR",
        ],
        devices.map((device) => [
          cyan(device.id),
          device.name ?? dim("—"),
          device.status,
          ago(device.createdAt),
          device.approvedAt ? ago(device.approvedAt) : dim("never"),
          device.lastSeenAt ? ago(device.lastSeenAt) : dim("never"),
          device.lastAttachedAt ? ago(device.lastAttachedAt) : dim("never"),
          device.lastSuccessAt ? ago(device.lastSuccessAt) : dim("never"),
          device.lastError ?? "",
        ]),
      ));
    }, { ok: true, devices });
    return;
  }

  if (invocation.kind === "approve") {
    if (!options.name?.trim()) fail("--name is required when approving a notification device");
    const preview = await api.notificationApprovalPreview(invocation.code);
    if (!options.yes) {
      emit(() => {
        console.log(`approve notification device ${bold(options.name!.trim())}?`);
        console.log(
          `  created ${ago(preview.createdAt)} · ${preview.deviceClass ?? "unknown device"}`,
        );
        console.log(`  ${preview.userAgentSummary ?? "unknown browser"}`);
        console.log(`  ${location(preview)} · ASN ${preview.asn ?? "unknown"}`);
      });
      const answer = prompt("approve this device? [y/N]");
      if (answer?.trim().toLowerCase() !== "y") {
        emit(() => console.log(dim("aborted")), { ok: false, error: "aborted" });
        return;
      }
    }
    const device = await api.approveNotificationDevice({
      code: invocation.code,
      name: options.name.trim(),
    });
    emit(
      () => console.log(`${green("✓")} approved ${bold(device.name ?? device.id)}`),
      { ok: true, device },
    );
    return;
  }

  if (invocation.kind === "revoke") {
    if (!options.yes) {
      const answer = prompt(`revoke notification device ${invocation.deviceId}? [y/N]`);
      if (answer?.trim().toLowerCase() !== "y") {
        emit(() => console.log(dim("aborted")), { ok: false, error: "aborted" });
        return;
      }
    }
    await api.revokeNotificationDevice(invocation.deviceId);
    emit(
      () => console.log(`${green("✓")} revoked ${bold(invocation.deviceId)}`),
      { ok: true, revoked: invocation.deviceId },
    );
    return;
  }

  const event: NotifyRequest = invocation.kind === "test"
    ? { title: "nzip", body: "nzip notifications are working", tag: "nzip-test" }
    : { body: invocation.body };
  if (invocation.kind === "send") {
    if (options.title !== undefined) event.title = options.title;
    if (options.tag !== undefined) event.tag = options.tag;
    if (options.open !== undefined) {
      const target = resolveCliTarget(options.open, config);
      const site = await api.siteDetail(target);
      event.path = `/${site.address}`;
    }
  }
  const response = await api.notify(event);
  emit(
    () =>
      console.log(
        `notification queued for ${response.queuedDevices} devices (event ${response.eventId})`,
      ),
    { ok: true, ...response },
  );
}
