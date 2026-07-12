import type { NotifyDeviceInfo } from "@nzip/shared";
import { filterNotificationDevices, parseNotifyInvocation } from "./notify.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("notify parses the primary send shape", () => {
  assertEquals(parseNotifyInvocation(["report ready"]), {
    kind: "send",
    body: "report ready",
  });
});

Deno.test("notify supports an explicit send subcommand for reserved bodies", () => {
  assertEquals(parseNotifyInvocation(["send", "test"]), {
    kind: "send",
    body: "test",
  });
});

Deno.test("notify parses test and device management subcommands", () => {
  assertEquals(parseNotifyInvocation(["test"]), { kind: "test" });
  assertEquals(parseNotifyInvocation(["approve", "ABCD-1234"]), {
    kind: "approve",
    code: "ABCD-1234",
  });
  assertEquals(parseNotifyInvocation(["devices"]), { kind: "devices" });
  assertEquals(parseNotifyInvocation(["revoke", "device-1"]), {
    kind: "revoke",
    deviceId: "device-1",
  });
});

Deno.test("notify devices hides tombstones unless all devices are requested", () => {
  const devices = ["pending", "approved", "active", "disabled", "revoked", "expired"].map(
    (status) => ({ status } as NotifyDeviceInfo),
  );

  assertEquals(
    filterNotificationDevices(devices, false).map((device) => device.status),
    ["pending", "approved", "active"],
  );
  assertEquals(filterNotificationDevices(devices, true), devices);
});
