import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { safe } from "./display.js";
import { commandExists } from "./github.js";
import { validBroker, X402_MQTT_VERSION } from "./build.js";
import { checkEndpoint, decodeBase64, formatUsdc, isLocal, networkOf, passed, type Accept, type CheckResult, type Finding, type TokenAccountLookup } from "./x402.js";

export const AWAL_VERSION = "2.12.1";
export const DEFAULT_CAP = "0.01";

export interface HandshakeOptions {
  method?: string | undefined;
  data?: string | undefined;
  max?: string | undefined;
  broker?: string | undefined;
  yes?: boolean | undefined;
  payTo?: string | undefined;
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
    const text = safe(finding.detail);
    const detail = finding.level === "fail" ? pc.red(text) : finding.level === "warn" ? pc.yellow(text) : pc.dim(text);
    console.log(`${marker(finding)} ${safe(finding.label).padEnd(14)} ${detail}`);
  }
}

export function explorer(networkId: string, transaction: string): string | undefined {
  if (networkId === "eip155:8453" && /^0x[0-9a-fA-F]{64}$/.test(transaction)) return `https://basescan.org/tx/${transaction}`;
  if (networkId === "eip155:84532" && /^0x[0-9a-fA-F]{64}$/.test(transaction)) return `https://sepolia.basescan.org/tx/${transaction}`;
  if (networkId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(transaction)) return `https://solscan.io/tx/${transaction}`;
  if (networkId === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(transaction)) return `https://solscan.io/tx/${transaction}?cluster=devnet`;
  return undefined;
}

export function isTransactionFor(networkId: string, transaction: string): boolean {
  const network = networkOf(networkId);
  if (!network) return false;
  return network.family === "evm"
    ? /^0x[0-9a-fA-F]{64}$/.test(transaction)
    : /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(transaction);
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
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(decodeBase64(value).toString("utf8")) as { success?: unknown; transaction?: unknown; network?: unknown };
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
  return accepts.filter((accept) => accept.scheme === "exact" && networkOf(accept.network)?.testnet === false && /^[1-9]\d{0,17}$/.test(accept.amount) && BigInt(accept.amount) <= cap);
}

function describe(accept: Accept): string {
  return `${formatUsdc(accept.amount)} USDC on ${networkOf(accept.network)?.name ?? accept.network} to ${accept.payTo}`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function payCommand(url: string, method: string, data: string | undefined, cap: bigint): string {
  const body = data ? ` -d ${quote(data)}` : "";
  return `npx awal@${AWAL_VERSION} x402 pay ${quote(url)} -X ${quote(method)}${body} --max-amount ${cap} --scheme exact`;
}

export const BASE_RPC = "https://mainnet.base.org";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface BaseReceipt {
  settled: boolean;
  reason?: string;
  payer?: string;
  payee?: string;
  amount?: string;
}

export interface SaleTerms {
  units: bigint;
  payTo?: string | undefined;
}

export async function confirmOnBase(
  transaction: string,
  sale: SaleTerms,
  fetcher: typeof fetch = fetch,
  attempts = 5
): Promise<BaseReceipt> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    let receipt: { status?: unknown; logs?: unknown } | null | undefined;
    try {
      const response = await fetcher(BASE_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [transaction] }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) continue;
      receipt = (await response.json() as { result?: { status?: unknown; logs?: unknown } | null }).result;
    } catch {
      continue;
    }
    if (!receipt) continue;
    if (receipt.status !== "0x1") return { settled: false, reason: "the transaction reverted on Base" };

    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const transfers = logs.flatMap((log) => {
      const entry = log as { address?: unknown; topics?: unknown; data?: unknown };
      const topics = Array.isArray(entry.topics) ? entry.topics : [];
      if (typeof entry.address !== "string" || entry.address.toLowerCase() !== BASE_USDC.toLowerCase()) return [];
      if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== transferTopic) return [];
      if (typeof topics[1] !== "string" || typeof topics[2] !== "string") return [];
      if (typeof entry.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(entry.data)) return [];
      return [{
        from: `0x${topics[1].slice(-40)}`,
        to: `0x${topics[2].slice(-40)}`,
        value: BigInt(entry.data)
      }];
    });

    if (transfers.length === 0) return { settled: false, reason: "no USDC transfer in that transaction" };
    const matched = transfers.find((transfer) =>
      transfer.value === sale.units
      && (!sale.payTo || transfer.to.toLowerCase() === sale.payTo.toLowerCase()));
    if (!matched) {
      return {
        settled: false,
        reason: sale.payTo
          ? `no USDC transfer of ${formatUsdc(sale.units.toString())} to ${sale.payTo} in that transaction`
          : `no USDC transfer of ${formatUsdc(sale.units.toString())} in that transaction`
      };
    }
    return {
      settled: true,
      payer: matched.from,
      payee: matched.to,
      amount: matched.value.toString()
    };
  }
  return { settled: false, reason: `no receipt on Base mainnet for ${transaction}` };
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
  if (options402.length === 0 && result.paymentRequired.accepts.some((accept) => networkOf(accept.network)?.testnet)) {
    console.log(pc.yellow("\nThis endpoint only takes testnet payments. The first sale has to be real: set X402_NETWORK=mainnet and your CDP keys, restart it, and run again.\n"));
    return false;
  }
  if (options402.length === 0) {
    console.log(pc.red(`\nEvery option costs more than the ${formatUsdc(cap.toString())} USDC cap. Raise it with --max.\n`));
    return false;
  }
  console.log(`\n${pc.bold("Pays one of")}`);
  for (const accept of options402) console.log(`  ${safe(describe(accept))}`);
  console.log(pc.dim(`  capped at ${formatUsdc(cap.toString())} USDC\n`));

  if (!await ensureAwal(options.confirm)) {
    console.log(`Pay from any x402 wallet with these terms, or run:\n  ${safe(payCommand(result.url, method, options.data, cap))}`);
    console.log(pc.dim(`Then check the listing with: cult handshake ${safe(quote(result.url))} --check\n`));
    return false;
  }
  if (!options.yes && !await options.confirm("Make this real payment now?")) {
    console.log(pc.dim("No payment made.\n"));
    return false;
  }

  const args = ["x402", "pay", result.url, "-X", method, ...(options.data ? ["-d", options.data] : []), "--max-amount", cap.toString(), "--scheme", "exact", "--json"];
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
  if (paid.status !== 0 || settlement?.success !== true || !settlement.network) {
    const status = Number(record?.status);
    console.log(pc.red(`\nNo payment went through${Number.isInteger(status) ? ` (HTTP ${status})` : ""}.`));
    if (typeof record?.error?.message === "string") console.log(pc.dim(`awal: ${safe(record.error.message).slice(0, 300)}`));
    console.log(pc.dim("If awal is not signed in, run: awal auth login you@example.com\n"));
    return false;
  }
  if (!options402.some((accept) => accept.network === settlement.network)) {
    console.log(pc.red(`\nawal settled on ${safe(settlement.network)}, which is not one of the mainnet options above, so this is not a first sale.\n`));
    return false;
  }
  const candidate = settlement?.transaction ?? findTransaction(output);
  const networks402 = settlement?.network ? [settlement.network] : options402.map((accept) => accept.network);
  const transaction = candidate && networks402.some((id) => isTransactionFor(id, candidate))
    ? candidate
    : undefined;
  if (!transaction) {
    console.log(pc.red("\nThe seller reported a payment without a settlement transaction, so there is nothing to prove it."));
    console.log(pc.dim("A first sale counts once the payment settles on chain and the receipt names the transaction.\n"));
    return false;
  }
  const link = (settlement?.network ? explorer(settlement.network, transaction) : undefined)
    ?? options402.map((accept) => explorer(accept.network, transaction)).find(Boolean);
  const done = Number(record?.status);
  console.log(pc.green(`\nFirst sale done${Number.isInteger(done) ? ` · HTTP ${done}` : ""}`));
  console.log(`${pc.dim("tx")}  ${link ?? safe(transaction)}`);
  console.log(`${pc.dim("listing")}  ${await listingStatus(result.url, options.fetcher)}\n`);
  return true;
}

async function handshakeMqtt(topic: string, options: HandshakeOptions): Promise<boolean> {
  if (options.checkOnly) {
    console.log(pc.dim("\nMachines are not listed on HTTP marketplaces, so there is nothing to check. No payment made.\n"));
    return true;
  }
  const broker = options.broker ?? "mqtt://127.0.0.1:1883";
  const max = options.max ?? DEFAULT_CAP;
  capUnits(max);
  if (topic.startsWith("-")) throw new Error(`Invalid machine topic: ${topic}`);
  if (!validBroker(broker)) {
    throw new Error("a remote broker must use mqtts:// or wss://; plain mqtt:// or ws:// only on this machine");
  }
  console.log(pc.bold("\nCULT OS // HANDSHAKE\n"));
  console.log(`${pc.dim("topic")}   ${topic}\n${pc.dim("broker")}  ${broker}\n${pc.dim("cap")}     ${max} USDC\n`);
  if (!process.env.X402_MQTT_BUYER_KEY) {
    console.log(pc.yellow("Machines are paid with your own small-balance buyer wallet. Load its key without typing it into your shell history, then run again:"));
    console.log("  read -rs X402_MQTT_BUYER_KEY && export X402_MQTT_BUYER_KEY");
    console.log(pc.dim("cult never stores it; x402-mqtt signs locally and only for USDC on Base.\n"));
    return false;
  }
  if (!options.yes && !await options.confirm("Make this real payment now?")) {
    console.log(pc.dim("No payment made.\n"));
    return false;
  }
  const bought = spawnSync("npx", ["--yes", `@cultos/x402-mqtt@${X402_MQTT_VERSION}`, "buy", topic, "--broker", broker, "--max", max], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3 * 60_000 });
  const output = `${bought.stdout ?? ""}\n${bought.stderr ?? ""}`;
  const transaction = output.match(/tx (0x[0-9a-fA-F]{64})/)?.[1];
  if (bought.status !== 0 || !transaction) {
    const reason = output.split("\n").map((line) => safe(line).trim()).filter(Boolean).pop();
    console.log(pc.red("\nNo payment went through."));
    if (reason) console.log(pc.dim(`x402-mqtt: ${reason.slice(0, 300)}`));
    return false;
  }
  const reported = output.match(/paid \$([0-9]+(?:\.[0-9]{1,6})?)/)?.[1];
  if (!reported) {
    console.log(pc.red("\nx402-mqtt did not report what it paid, so the receipt cannot be matched to the sale.\n"));
    return false;
  }
  console.log(pc.dim("Confirming the receipt on Base…"));
  const receipt = await confirmOnBase(
    transaction,
    { units: capUnits(reported), ...(options.payTo ? { payTo: options.payTo } : {}) },
    options.fetcher
  );
  if (!receipt.settled) {
    console.log(pc.red(`\nx402-mqtt reported a payment that Base does not confirm: ${safe(receipt.reason ?? "unknown")}.`));
    console.log(`${pc.dim("tx")}  ${explorer("eip155:8453", transaction) ?? safe(transaction)}\n`);
    return false;
  }
  const paid = output.match(/paid \$[0-9.]+ · [^\n]*/)?.[0];
  console.log(pc.green("\nFirst sale done on Base"));
  if (paid) console.log(pc.dim(safe(paid).replace(/ · tx .*/, "")));
  if (receipt.amount) {
    console.log(`${pc.dim("settled")}  ${formatUsdc(receipt.amount)} USDC from ${safe(receipt.payer ?? "")} to ${safe(receipt.payee ?? "")}`);
  }
  if (!options.payTo) {
    console.log(pc.dim("Pass --pay-to <address> to also require the payout address to match."));
  }
  console.log(`${pc.dim("tx")}  ${explorer("eip155:8453", transaction)}\n`);
  return true;
}

export async function runHandshake(target: string, options: HandshakeOptions): Promise<boolean> {
  return /^https?:\/\//i.test(target) ? handshakeHttp(target, options) : handshakeMqtt(target, options);
}
