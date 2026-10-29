// The VmPower port (contract.ts) over the Nebius JS SDK: Get, Start and Stop of the one configured
// builder instance, and nothing else. The service-account key behind it has the instance
// power-operator role on that instance only, so it cannot resize, create or read anything else.
//
// The SDK loads lazily, on the first call, so a module that only builds the port (and the tests,
// which pass a fake InstanceClient) never loads it. A missing credential variable leaves no port at
// all (nebiusPowerFrom answers null): production then treats power as unavailable (fail closed).
import { randomUUID } from "node:crypto";
import { StartError, type NebiusInstanceState, type VmPower } from "../contract.ts";

/** The four RBW_NEBIUS_* values, as the OTF config section reads them; null there when any is unset. */
export interface NebiusPowerCredentials {
  /** RBW_NEBIUS_SA_ID */
  serviceAccountId: string;
  /** RBW_NEBIUS_SA_KEY_ID */
  keyId: string;
  /** RBW_NEBIUS_SA_PRIVATE_KEY: the PEM private key. Never logged and never sent anywhere but the signer. */
  privateKey: string;
  /** RBW_NEBIUS_VM_ID */
  instanceId: string;
}

/** What one instance call answers, already reduced to the fields the port uses. */
export interface InstanceSnapshot {
  /** The provider's state name, e.g. RUNNING or STOPPED. */
  state: string;
  /** The resources preset, or "" when the instance spec names none. */
  preset: string;
}

/** The three instance calls, by instance ID. The SDK implements it; the tests pass a fake. */
export interface InstanceClient {
  get(instanceId: string): Promise<InstanceSnapshot>;
  start(instanceId: string): Promise<{ operation_id: string }>;
  stop(instanceId: string): Promise<{ operation_id: string }>;
}

/** gRPC status codes the port tells apart. */
const GRPC_ALREADY_EXISTS = 6;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_FAILED_PRECONDITION = 9;

/** One request window per call, so a stalled API cannot hold a function for the SDK's default minute. */
const CALL_TIMEOUT_MS = 15_000;
const USER_AGENT = "rbw-otf-power/0";

/** The operation ID reported when Start or Stop had nothing to do. */
export const NOOP_OPERATION = "noop";

export function instanceState(name: string): NebiusInstanceState {
  return name === "RUNNING" || name === "STOPPED" || name === "STARTING" || name === "STOPPING" ? name : "OTHER";
}

function grpcCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "number" ? code : null;
}

/** A short, credential-free description of a failed call: the gRPC code only, never the details. */
function describe(action: string, error: unknown): string {
  const code = grpcCode(error);
  return code === null ? `Nebius ${action} failed` : `Nebius ${action} failed (gRPC code ${String(code)})`;
}

/**
 * The port over an InstanceClient for one instance. Each method makes exactly one call, so the
 * lifecycle's one-call-per-interval rule holds. Start and Stop are no-ops in effect when the
 * instance is already where the call would take it: the provider refuses those with
 * FAILED_PRECONDITION (or ALREADY_EXISTS), which answers NOOP_OPERATION, and the lifecycle's next
 * Get shows the state the instance is really in.
 */
export function createVmPower(client: InstanceClient, instanceId: string): VmPower {
  const already = (error: unknown): boolean => {
    const code = grpcCode(error);
    return code === GRPC_FAILED_PRECONDITION || code === GRPC_ALREADY_EXISTS;
  };
  return {
    async get() {
      const found = await client.get(instanceId);
      return { state: instanceState(found.state), preset: found.preset };
    },
    async start() {
      try {
        return await client.start(instanceId);
      } catch (error) {
        if (already(error)) return { operation_id: NOOP_OPERATION };
        throw new StartError(grpcCode(error) === GRPC_RESOURCE_EXHAUSTED ? "capacity" : "api_error", describe("start", error));
      }
    },
    async stop() {
      try {
        return await client.stop(instanceId);
      } catch (error) {
        if (already(error)) return { operation_id: NOOP_OPERATION };
        throw new Error(describe("stop", error), { cause: error });
      }
    },
  };
}

/**
 * The InstanceClient over the SDK's generated compute and IAM messages, sent with @grpc/grpc-js.
 *
 * It does not construct the SDK's top-level client: that module imports the SDK's file token cache,
 * whose native addon (fs-ext) the workspace install does not build, so loading it fails. The
 * message codecs, the service paths and the service-account JWT signer load without it. The calls
 * go to the SDK's own conventional addresses, with the SDK's per-request idempotency key and a
 * service-account access token from the IAM token exchange, renewed a minute before it expires.
 */
export function sdkInstanceClient(credentials: NebiusPowerCredentials): InstanceClient {
  let loading: Promise<Wire> | null = null;
  const wire = (): Promise<Wire> => {
    loading ??= loadWire(credentials).catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
  return {
    async get(id) {
      const w = await wire();
      const instance = await w.compute(w.api.compute.InstanceServiceServiceDescription.get, w.api.compute.GetInstanceRequest.create({ id }));
      const size = instance.spec?.resources?.size;
      return { state: instance.status?.state.name ?? "UNSPECIFIED", preset: size?.$case === "preset" ? size.preset : "" };
    },
    async start(id) {
      const w = await wire();
      const operation = await w.compute(w.api.compute.InstanceServiceServiceDescription.start, w.api.compute.StartInstanceRequest.create({ id }));
      return { operation_id: operation.id };
    },
    async stop(id) {
      const w = await wire();
      const operation = await w.compute(w.api.compute.InstanceServiceServiceDescription.stop, w.api.compute.StopInstanceRequest.create({ id }));
      return { operation_id: operation.id };
    },
  };
}

type ComputeApi = typeof import("@nebius/js-sdk/api/nebius/compute/v1/index");
type IamApi = typeof import("@nebius/js-sdk/api/nebius/iam/v1/index");
type Grpc = typeof import("@grpc/grpc-js");

/** One unary method as the generated service descriptions give it. */
interface UnaryMethod<Req, Res> {
  path: string;
  requestSerialize: (value: Req) => Buffer;
  responseDeserialize: (value: Buffer) => Res;
}

interface Wire {
  api: { compute: ComputeApi };
  compute<Req, Res>(method: UnaryMethod<Req, Res>, request: Req): Promise<Res>;
}

/** The SDK's default domain and its conventional service addresses (runtime/constants, runtime/resolver). */
const COMPUTE_ADDRESS = "compute.api.nebius.cloud:443";
const TOKENS_ADDRESS = "tokens.iam.api.nebius.cloud:443";
/** Renew the access token this long before it expires. */
const TOKEN_RENEW_MS = 60_000;

function unary<Req, Res>(client: InstanceType<Grpc["Client"]>, method: UnaryMethod<Req, Res>, request: Req, metadata: InstanceType<Grpc["Metadata"]>): Promise<Res> {
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize, request, metadata, { deadline: Date.now() + CALL_TIMEOUT_MS }, (error, response) => {
      if (error !== null) reject(error);
      else if (response === undefined) reject(new Error(`empty answer from ${method.path}`));
      else resolve(response);
    });
  });
}

async function loadWire(credentials: NebiusPowerCredentials): Promise<Wire> {
  const [grpc, compute, iam, { ServiceAccount }] = await Promise.all([
    import("@grpc/grpc-js"),
    import("@nebius/js-sdk/api/nebius/compute/v1/index"),
    import("@nebius/js-sdk/api/nebius/iam/v1/index"),
    import("@nebius/js-sdk/runtime/service_account/service_account"),
  ]);
  const options = { "grpc.primary_user_agent": USER_AGENT };
  const computeClient = new grpc.Client(COMPUTE_ADDRESS, grpc.credentials.createSsl(), options);
  const tokensClient = new grpc.Client(TOKENS_ADDRESS, grpc.credentials.createSsl(), options);
  const account = new ServiceAccount(credentials.privateKey, credentials.keyId, credentials.serviceAccountId);
  let token: { value: string; renewAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token !== null && Date.now() < token.renewAt) return token.value;
    const exchange: UnaryMethod<ReturnType<typeof account.getExchangeTokenRequest>, ReturnType<IamApi["CreateTokenResponse"]["decode"]>> = iam.TokenExchangeServiceServiceDescription.exchange;
    const answer = await unary(tokensClient, exchange, account.getExchangeTokenRequest(), new grpc.Metadata());
    const lifetimeMs = Number(answer.expiresIn.toString()) * 1000;
    token = { value: answer.accessToken, renewAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_RENEW_MS) };
    return token.value;
  }

  return {
    api: { compute },
    async compute(method, request) {
      const metadata = new grpc.Metadata();
      metadata.set("authorization", `Bearer ${await accessToken()}`);
      metadata.set("x-idempotency-key", randomUUID());
      return unary(computeClient, method, request, metadata);
    },
  };
}

const cached = new Map<string, VmPower>();

/**
 * The production port for these credentials, or null when there are none (any RBW_NEBIUS_*
 * variable unset). One port per credential set per function instance, so the SDK's channel and
 * its renewed access token are reused across requests.
 */
export function nebiusPowerFrom(credentials: NebiusPowerCredentials | null): VmPower | null {
  if (credentials === null) return null;
  const { serviceAccountId, keyId, privateKey, instanceId } = credentials;
  if (serviceAccountId === "" || keyId === "" || privateKey === "" || instanceId === "") return null;
  const key = `${serviceAccountId}\n${keyId}\n${instanceId}`;
  let power = cached.get(key);
  if (power === undefined) {
    power = createVmPower(sdkInstanceClient(credentials), instanceId);
    cached.set(key, power);
  }
  return power;
}
