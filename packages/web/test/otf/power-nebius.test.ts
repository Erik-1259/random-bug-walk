// The VmPower port over the Nebius instance calls, against a fake InstanceClient (no network), and
// the SDK modules it loads, which must load without the SDK's native file-lock addon. Every ID and
// key here is synthetic.
import { describe, expect, it } from "vitest";
import { StartError } from "../../src/otf/contract.ts";
import { NOOP_OPERATION, createVmPower, instanceState, nebiusPowerFrom, type InstanceClient, type InstanceSnapshot, type NebiusPowerCredentials } from "../../src/otf/power/nebius.ts";

const INSTANCE = "synthetic-instance-1";

function grpcError(code: number, details: string): Error & { code: number; details: string } {
  return Object.assign(new Error(`${String(code)} synthetic: ${details}`), { code, details });
}

class FakeClient implements InstanceClient {
  calls: string[] = [];
  snapshot: InstanceSnapshot = { state: "STOPPED", preset: "synthetic-preset" };
  startError: Error | null = null;
  stopError: Error | null = null;
  get(id: string): Promise<InstanceSnapshot> {
    this.calls.push(`get ${id}`);
    return Promise.resolve(this.snapshot);
  }
  start(id: string): Promise<{ operation_id: string }> {
    this.calls.push(`start ${id}`);
    return this.startError === null ? Promise.resolve({ operation_id: "synthetic-op-start" }) : Promise.reject(this.startError);
  }
  stop(id: string): Promise<{ operation_id: string }> {
    this.calls.push(`stop ${id}`);
    return this.stopError === null ? Promise.resolve({ operation_id: "synthetic-op-stop" }) : Promise.reject(this.stopError);
  }
}

const CREDENTIALS: NebiusPowerCredentials = {
  serviceAccountId: "synthetic-service-account",
  keyId: "synthetic-key",
  privateKey: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n",
  instanceId: INSTANCE,
};

describe("instanceState", () => {
  it("keeps the four power states and folds every other provider state into OTHER", () => {
    expect(["RUNNING", "STOPPED", "STARTING", "STOPPING"].map(instanceState)).toEqual(["RUNNING", "STOPPED", "STARTING", "STOPPING"]);
    expect(["CREATING", "UPDATING", "DELETING", "ERROR", "UNSPECIFIED", ""].map(instanceState)).toEqual(Array(6).fill("OTHER"));
  });
});

describe("createVmPower", () => {
  it("exposes get, start and stop of the one configured instance and nothing else", async () => {
    const client = new FakeClient();
    const power = createVmPower(client, INSTANCE);
    expect(Object.keys(power).sort()).toEqual(["get", "start", "stop"]);
    client.snapshot = { state: "RUNNING", preset: "synthetic-preset-b" };
    expect(await power.get()).toEqual({ state: "RUNNING", preset: "synthetic-preset-b" });
    expect(await power.start()).toEqual({ operation_id: "synthetic-op-start" });
    expect(await power.stop()).toEqual({ operation_id: "synthetic-op-stop" });
    expect(client.calls).toEqual([`get ${INSTANCE}`, `start ${INSTANCE}`, `stop ${INSTANCE}`]);
  });

  it("treats a refused Start or Stop of an instance already there as a no-op, with no second call", async () => {
    for (const code of [9, 6]) {
      const client = new FakeClient();
      const power = createVmPower(client, INSTANCE);
      client.startError = grpcError(code, "synthetic-detail-already");
      client.stopError = grpcError(code, "synthetic-detail-already");
      expect(await power.start()).toEqual({ operation_id: NOOP_OPERATION });
      expect(await power.stop()).toEqual({ operation_id: NOOP_OPERATION });
      expect(client.calls).toEqual([`start ${INSTANCE}`, `stop ${INSTANCE}`]);
    }
  });

  it("throws StartError capacity on RESOURCE_EXHAUSTED and api_error otherwise, naming only the gRPC code", async () => {
    const client = new FakeClient();
    const power = createVmPower(client, INSTANCE);
    client.startError = grpcError(8, "synthetic-detail-capacity");
    const capacity = await power.start().catch((error: unknown) => error);
    expect(capacity).toBeInstanceOf(StartError);
    expect(capacity).toMatchObject({ reason: "capacity", message: "Nebius start failed (gRPC code 8)" });
    client.startError = grpcError(7, "synthetic-detail-denied");
    await expect(power.start()).rejects.toMatchObject({ reason: "api_error", message: "Nebius start failed (gRPC code 7)" });
    client.startError = grpcError(3, "synthetic-detail-invalid");
    await expect(power.start()).rejects.toMatchObject({ reason: "api_error", message: "Nebius start failed (gRPC code 3)" });
    client.startError = new TypeError("synthetic network failure");
    await expect(power.start()).rejects.toMatchObject({ name: "StartError", reason: "api_error", message: "Nebius start failed" });
    expect(client.calls.every((call) => call.startsWith("start "))).toBe(true);
  });

  it("rethrows any other Stop failure without the provider's details", async () => {
    const client = new FakeClient();
    const power = createVmPower(client, INSTANCE);
    client.stopError = grpcError(7, "synthetic-detail-denied");
    await expect(power.stop()).rejects.toThrow(/^Nebius stop failed \(gRPC code 7\)$/);
    client.stopError = new TypeError("synthetic network failure");
    await expect(power.stop()).rejects.toThrow(/^Nebius stop failed$/);
  });
});

describe("nebiusPowerFrom", () => {
  it("fails closed without credentials or with an empty one", () => {
    expect(nebiusPowerFrom(null)).toBeNull();
    for (const field of ["serviceAccountId", "keyId", "privateKey", "instanceId"] as const) {
      expect(nebiusPowerFrom({ ...CREDENTIALS, [field]: "" })).toBeNull();
    }
  });

  it("builds one port per credential set without loading the SDK or calling the API", () => {
    const power = nebiusPowerFrom(CREDENTIALS);
    expect(power).not.toBeNull();
    expect(nebiusPowerFrom({ ...CREDENTIALS })).toBe(power);
    expect(nebiusPowerFrom({ ...CREDENTIALS, instanceId: "synthetic-instance-2" })).not.toBe(power);
  });
});

describe("the SDK modules the port loads", () => {
  it("load without the native file-lock addon and carry the Get, Start and Stop paths", async () => {
    const compute = await import("@nebius/js-sdk/api/nebius/compute/v1/index");
    const iam = await import("@nebius/js-sdk/api/nebius/iam/v1/index");
    const { ServiceAccount } = await import("@nebius/js-sdk/runtime/service_account/service_account");
    const methods = compute.InstanceServiceServiceDescription;
    expect([methods.get.path, methods.start.path, methods.stop.path]).toEqual(["/nebius.compute.v1.InstanceService/Get", "/nebius.compute.v1.InstanceService/Start", "/nebius.compute.v1.InstanceService/Stop"]);
    expect(iam.TokenExchangeServiceServiceDescription.exchange.path).toBe("/nebius.iam.v1.TokenExchangeService/Exchange");
    const encoded = methods.get.requestSerialize(compute.GetInstanceRequest.create({ id: INSTANCE }));
    expect(compute.GetInstanceRequest.decode(encoded).id).toBe(INSTANCE);
    expect(typeof ServiceAccount).toBe("function");
  });
});
