import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capUnits, explorer, findTransaction, listingStatus, runHandshake } from "../src/handshake.js";

const payTo = "0x000000000000000000000000000000000000dEaD";
const tx = `0x${"ab".repeat(32)}`;
const header = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo, maxTimeoutSeconds: 60 }],
  extensions: { bazaar: {} }
})).toString("base64");

const endpoint = "https://api.example.com/data";
const quote = (async (input: RequestInfo | URL) => String(input).startsWith("https://api.agentic.market")
  ? new Response("", { status: 404 })
  : new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } })) as typeof fetch;

let server: Server;
let origin: string;
let directory: string;
let previousPath: string | undefined;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(402, { "PAYMENT-REQUIRED": header });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cultos-handshake-"));
  previousPath = process.env.PATH;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env.PATH = previousPath;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function fakeAwal(output: string): string {
  const log = join(directory, "awal.log");
  const path = join(directory, "awal");
  writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = "--version" ]; then echo 2.12.1; exit 0; fi\necho '${output}'\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${directory}:${previousPath}`;
  return log;
}

describe("cult handshake", () => {
  it("parses caps in USDC units", () => {
    expect(capUnits("0.01")).toBe(10_000n);
    expect(capUnits("1")).toBe(1_000_000n);
    expect(() => capUnits("0.0000001")).toThrow("--max");
  });

  it("finds a transaction anywhere in a receipt and links the right explorer", () => {
    expect(findTransaction({ data: { paymentResponse: { transaction: tx } } })).toBe(tx);
    expect(findTransaction({ status: 200 })).toBeUndefined();
    expect(explorer("eip155:8453", tx)).toBe(`https://basescan.org/tx/${tx}`);
    expect(explorer("eip155:1", tx)).toBeUndefined();
  });

  it("pays through awal with the cap and never without confirmation", async () => {
    const receipt = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:8453" })).toString("base64");
    const log = fakeAwal(JSON.stringify({ status: 200, data: { ok: true }, headers: { "PAYMENT-RESPONSE": receipt } }));
    const declined = await runHandshake(endpoint, { confirm: async () => false, fetcher: quote });
    expect(declined).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("x402 pay");

    const paid = await runHandshake(endpoint, { confirm: async () => true, max: "0.002", fetcher: quote });
    expect(paid).toBe(true);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`x402 pay ${endpoint} -X GET --max-amount 2000 --scheme exact --json`);
  });

  it("refuses when every option costs more than the cap", async () => {
    const log = fakeAwal("{}");
    const result = await runHandshake(endpoint, { confirm: async () => true, max: "0.0005", fetcher: quote });
    expect(result).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("reports a payment that did not go through", async () => {
    fakeAwal(JSON.stringify({ success: false, error: { message: "insufficient balance" } }));
    expect(await runHandshake(endpoint, { confirm: async () => true, fetcher: quote })).toBe(false);
  });

  it("never counts a settlement on another network as the first sale", async () => {
    const receipt = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:84532" })).toString("base64");
    fakeAwal(JSON.stringify({ status: 200, headers: { "PAYMENT-RESPONSE": receipt } }));
    expect(await runHandshake(endpoint, { confirm: async () => true, fetcher: quote })).toBe(false);
  });

  it("never counts a testnet payment as the first sale", async () => {
    const log = fakeAwal("{}");
    const testnet = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "1000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo, maxTimeoutSeconds: 60 }],
      extensions: { bazaar: {} }
    })).toString("base64");
    const fetcher = (async () => new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": testnet } })) as typeof fetch;
    expect(await runHandshake(endpoint, { confirm: async () => true, fetcher })).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("never sends a first sale over plain http", async () => {
    const log = fakeAwal("{}");
    expect(await runHandshake(`${origin}/data`, { confirm: async () => true })).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("never pays a machine in check-only mode", async () => {
    const previous = process.env.X402_MQTT_BUYER_KEY;
    process.env.X402_MQTT_BUYER_KEY = "0x" + "1".repeat(64);
    const log = join(directory, "npx.log");
    writeFileSync(join(directory, "npx"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(directory, "npx"), 0o755);
    process.env.PATH = `${directory}:${previousPath}`;
    try {
      expect(await runHandshake("mac/cpu/load", { confirm: async () => true, yes: true, checkOnly: true })).toBe(true);
      expect(existsSync(log)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.X402_MQTT_BUYER_KEY; else process.env.X402_MQTT_BUYER_KEY = previous;
    }
  });

  it("counts a machine sale only with a real Base transaction", async () => {
    const previous = process.env.X402_MQTT_BUYER_KEY;
    process.env.X402_MQTT_BUYER_KEY = "0x" + "1".repeat(64);
    process.env.PATH = `${directory}:${previousPath}`;
    try {
      writeFileSync(join(directory, "npx"), "#!/bin/sh\necho 'no eip155:8453 option in the quote' >&2\nexit 1\n");
      chmodSync(join(directory, "npx"), 0o755);
      expect(await runHandshake("mac/cpu/load", { confirm: async () => true, yes: true })).toBe(false);
      writeFileSync(join(directory, "npx"), `#!/bin/sh\necho 'paid $0.001 · 1.9 load · tx ${tx}'\n`);
      expect(await runHandshake("mac/cpu/load", { confirm: async () => true, yes: true })).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.X402_MQTT_BUYER_KEY; else process.env.X402_MQTT_BUYER_KEY = previous;
    }
  });

  it("asks for the buyer's own key for machines instead of holding one", async () => {
    const previous = process.env.X402_MQTT_BUYER_KEY;
    delete process.env.X402_MQTT_BUYER_KEY;
    try {
      expect(await runHandshake("mac/cpu/load", { confirm: async () => true })).toBe(false);
    } finally {
      if (previous !== undefined) process.env.X402_MQTT_BUYER_KEY = previous;
    }
  });

  it("never prints terminal control sequences from a hostile payment header", async () => {
    const hostile = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts: [
        { scheme: "exact\u001b]52;c;cHduZWQ=\u0007", network: "eip155:8453\u001b[2J", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\u001b[31m", payTo: "\u001b[1A\u001b[2Kpaid", maxTimeoutSeconds: 60 },
        { scheme: "exact", network: "solana:\u001b[2Jfake", amount: "1000", asset: "x", payTo: "y" }
      ]
    })).toString("base64");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    const fetcher = (async () => new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": hostile } })) as typeof fetch;
    await runHandshake("https://api.example.com/data", { confirm: async () => false, fetcher });
    const printed = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(printed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("reads the Agentic Market listing", async () => {
    const listed = async () => new Response(JSON.stringify({ endpoints: [{ url: "https://api.example.com/data" }] }), { status: 200 });
    expect(await listingStatus("https://api.example.com/data", listed as typeof fetch)).toBe("listed on Agentic Market");
    expect(await listingStatus("https://api.example.com/other", listed as typeof fetch)).toContain("endpoint not yet");
    expect(await listingStatus("https://api.example.com/data", (async () => new Response("", { status: 404 })) as typeof fetch)).toContain("not on Agentic Market yet");
    expect(await listingStatus("http://localhost:4021/data")).toContain("local only");
  });
});
