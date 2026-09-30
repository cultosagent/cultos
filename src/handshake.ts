import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { commandExists } from "./github.js";
import { X402_MQTT_VERSION } from "./build.js";
import { checkEndpoint, formatUsdc, isLocal, networkOf, passed, type Accept, type CheckResult, type Finding, type TokenAccountLookup } from "./x402.js";

export const AWAL_VERSION = "2.12.1";
export const DEFAULT_CAP = "0.01";

export interface HandshakeOptions {
  method?: string | undefined;
  data?: string | undefined;
  max?: string | undefined;
  broker?: string | undefined;
  yes?: boolean | undefined;
  checkOnly?: boolean | undefined;
  confirm: (question: string) => Promise<boolean>;
  fetcher?: typeof fetch | undefined;
  tokenAccount?: TokenAccountLookup | undefined;
}

export function capUnits(max: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(max)) throw new Error("--max must be a USD amount like 0.01");
  const [whole, fraction = ""] = max.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function printFindings(result: CheckResult): void {
  const marker = (finding: Finding) => finding.level === "pass" ? pc.green("●") : finding.level === "warn" ? pc.yellow("○") : pc.red("✕");
  for (const finding of result.findings) {
    const detail = finding.level === "fail" ? pc.red(finding.detail) : finding.level === "warn" ? pc.yellow(finding.detail) : pc.dim(finding.detail);
    console.log(`${marker(finding)} ${finding.label.padEnd(14)} ${detail}`);
  }
}

export function explorer(networkId: string, transaction: string): string | undefined {
  if (networkId === "eip155:8453" && /^0x[0-9a-fA-F]{64}$/.test(transaction)) return `https://basescan.org/tx/${transaction}`;
  if (networkId === "eip155:84532" && /^0x[0-9a-fA-F]{64}$/.test(transaction)) return `https://sepolia.basescan.org/tx/${transaction}`;
  if (networkId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(transaction)) return `https://solscan.io/tx/${transaction}`;
  if (networkId === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(transaction)) return `https://solscan.io/tx/${transaction}?cluster=devnet`;
  return undefined;
}

export function findTransaction(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^0x[0-9a-fA-F]{64}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value) ? value : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["transaction", "txHash", "transactionHash", "signature"]) {
    const found = findTransaction(record[key]);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    if (item && typeof item === "object") {
      const found = findTransaction(item);
      if (found) return found;
    }
  }
  return undefined;
}

export function settlementOf(headers: Record<string, string> | undefined): { success?: boolean; transaction?: string; network?: string } | undefined {
  const value = headers && Object.entries(headers).find(([key]) => key.toLowerCase() === "payment-response")?.[1];
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as { success?: unknown; transaction?: unknown; network?: unknown };
    return {
      ...(typeof parsed.success === "boolean" ? { success: parsed.success } : {}),
      ...(typeof parsed.transaction === "string" ? { transaction: parsed.transaction } : {}),
      ...(typeof parsed.network === "string" ? { network: parsed.network } : {})
    };
  } catch {
    return undefined;
  }
}

export async function listingStatus(target: string, fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL(target);
  if (isLocal(url)) return "local only: deploy it, then its first sale gets it listed";
  const id = url.hostname.replace(/\./g, "-");
  try {
    const response = await fetcher(`https://api.agentic.market/v1/services/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return "not on Agentic Market yet: marketplaces list a seller after its first settlement, which can take a while";
    if (!response.ok) return `Agentic Market unavailable (${response.status})`;
    const service = await response.json() as { endpoints?: { url?: string }[] };
    const path = `${url.origin}${url.pathname}`;
    return service.endpoints?.some((endpoint) => endpoint.url === path)
      ? "listed on Agentic Market"
      : "this domain is on Agentic Market, this endpoint not yet";
  } catch {
    return "Agentic Market unreachable";
  }
}

function affordable(accepts: Accept[], cap: bigint): Accept[] {
  return accepts.filter((accept) => networkOf(accept.network) && BigInt(accept.amount) <= cap);
}

function describe(accept: Accept): string {
  return `${formatUsdc(accept.amount)} USDC on ${networkOf(accept.network)?.name ?? accept.network} to ${accept.payTo}`;
}

function payCommand(url: string, method: string, data: string | undefined, cap: bigint): string {
  const body = data ? ` -d '${data.replace(/'/g, "'\\''")}'` : "";
  return `npx awal@${AWAL_VERSION} x402 pay ${url} -X ${method}${body} --max-amount ${cap}`;
}

export async function ensureAwal(confirm: HandshakeOptions["confirm"]): Promise<boolean> {
  if (commandExists("awal")) return true;
  console.log(pc.yellow("\nThe first sale needs a payer. Coinbase's awal wallet keeps its key off this machine."));
  if (!await confirm(`Install awal ${AWAL_VERSION} now?`)) {
    console.log(pc.dim("No problem. cult handshake offers it again when you make the first sale."));
    return false;
  }
  const install = spawnSync("npm", ["install", "-g", `awal@${AWAL_VERSION}`], { stdio: "inherit", timeout: 5 * 60_000 });
  if (install.status !== 0 || !commandExists("awal")) {
    console.log(pc.red("awal installation failed"));
    return false;
  }
  console.log(pc.dim("Sign in once with: awal auth login you@example.com"));
  return true;
}

async function handshakeHttp(target: string, options: HandshakeOptions): Promise<boolean> {
  const method = (options.method ?? (options.data ? "POST" : "GET")).toUpperCase();
  if (options.checkOnly) {
    console.log(`\n${pc.bold("Listing")}  ${await listingStatus(target, options.fetcher)}\n`);
    return true;
  }
  const cap = capUnits(options.max ?? DEFAULT_CAP);
  if (new URL(target).protocol !== "https:") {
    console.log(pc.yellow("\nThe first sale needs the public https address. Payers refuse plain http, even on localhost."));
    console.log(pc.dim("Deploy it, or expose it for a test with a tunnel such as: cloudflared tunnel --url http://localhost:4021\n"));
    return false;
  }
  const result = await checkEndpoint(target, { method, data: options.data, fetcher: options.fetcher, tokenAccount: options.tokenAccount });
  console.log(pc.bold("\nCULT OS // HANDSHAKE\n"));
  printFindings(result);
  if (!passed(result) || !result.paymentRequired) {
    console.log(pc.red("\nFix the failed checks before the first sale.\n"));
    return false;
  }
  const options402 = affordable(result.paymentRequired.accepts, cap);
  if (options402.length === 0) {
    console.log(pc.red(`\nEvery option costs more than the ${formatUsdc(cap.toString())} USDC cap. Raise it with --max.\n`));
    return false;
  }
  console.log(`\n${pc.bold("Pays one of")}`);
  for (const accept of options402) console.log(`  ${describe(accept)}`);
  console.log(pc.dim(`  capped at ${formatUsdc(cap.toString())} USDC\n`));

  if (!await ensureAwal(options.confirm)) {
    console.log(`Pay from any x402 wallet with these terms, or run:\n  ${payCommand(result.url, method, options.data, cap)}`);
    console.log(pc.dim(`Then check the listing with: cult handshake ${result.url} --check\n`));
    return false;
  }
  if (!options.yes && !await options.confirm("Make this real payment now?")) {
    console.log(pc.dim("No payment made.\n"));
    return false;
  }

  const args = ["x402", "pay", result.url, "-X", method, ...(options.data ? ["-d", options.data] : []), "--max-amount", cap.toString(), "--json"];
  console.log(pc.dim("Paying through awal…"));
  const paid = spawnSync("awal", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3 * 60_000 });
  let output: unknown;
  try {
    output = JSON.parse(paid.stdout.trim());
  } catch {
    output = undefined;
  }
  const record = output as { status?: number; paymentMade?: boolean; headers?: Record<string, string>; error?: { message?: string } } | undefined;
  const settlement = settlementOf(record?.headers);
  if (paid.status !== 0 || !(record?.paymentMade === true || settlement?.success === true)) {
    console.log(pc.red(`\nNo payment went through${record?.status ? ` (HTTP ${record.status})` : ""}.`));
    if (record?.error?.message) console.log(pc.dim(`awal: ${record.error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}`));
    console.log(pc.dim("If awal is not signed in, run: awal auth login you@example.com\n"));
    return false;
  }
  const transaction = settlement?.transaction ?? findTransaction(output);
  const link = transaction
    ? (settlement?.network ? explorer(settlement.network, transaction) : undefined) ?? options402.map((accept) => explorer(accept.network, transaction)).find(Boolean)
    : undefined;
  console.log(pc.green(`\nFirst sale done · HTTP ${record?.status ?? "?"}`));
  if (transaction) console.log(`${pc.dim("tx")}  ${link ?? transaction}`);
  console.log(`${pc.dim("listing")}  ${await listingStatus(result.url, options.fetcher)}\n`);
  return true;
}

async function handshakeMqtt(topic: string, options: HandshakeOptions): Promise<boolean> {
  const broker = options.broker ?? "mqtt://127.0.0.1:1883";
  const max = options.max ?? DEFAULT_CAP;
  capUnits(max);
  console.log(pc.bold("\nCULT OS // HANDSHAKE\n"));
  console.log(`${pc.dim("topic")}   ${topic}\n${pc.dim("broker")}  ${broker}\n${pc.dim("cap")}     ${max} USDC\n`);
  if (!process.env.X402_MQTT_BUYER_KEY) {
    console.log(pc.yellow("Machines are paid with your own small-balance buyer wallet. Set X402_MQTT_BUYER_KEY and run again."));
    console.log(pc.dim("cult never stores it; x402-mqtt signs locally and only for USDC on Base.\n"));
    return false;
  }
  if (!options.yes && !await options.confirm("Make this real payment now?")) {
    console.log(pc.dim("No payment made.\n"));
    return false;
  }
  const bought = spawnSync("npx", ["--yes", `@cultos/x402-mqtt@${X402_MQTT_VERSION}`, "buy", topic, "--broker", broker, "--max", max], { stdio: "inherit", timeout: 3 * 60_000 });
  return bought.status === 0;
}

export async function runHandshake(target: string, options: HandshakeOptions): Promise<boolean> {
  return /^https?:\/\//i.test(target) ? handshakeHttp(target, options) : handshakeMqtt(target, options);
}
