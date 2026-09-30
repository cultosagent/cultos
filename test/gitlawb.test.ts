import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGitLawbIssue,
  getGitLawbPullRequest,
  getGitLawbRepository,
  getGitLawbVerificationChecks,
  parseGitLawbRemote
} from "../src/gitlawb.js";

const originalPath = process.env.PATH;
let bin: string;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function executable(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "cultos-gitlawb-"));
  process.env.PATH = `${bin}:${originalPath}`;
  executable("gl", `
case "$1 $2" in
  "repo info") printf '%s\\n' 'Repository: z6MkOwner/example' '  Owner DID:  did:key:z6MkOwner' '  Branch:     main' ;;
  "issue show") printf '%s\\n' 'Issue: issue-id' '  Title:   Fix adapter' '  Status:  open' '' 'Acceptance criteria' '- [ ] Tests pass' ;;
  "pr view") printf '%s\\n' 'PR #1: Fix adapter' '  Status: open' '  Branch: feature/fix → main' ;;
  "cert list") printf '%s\\n' '  abcdef12  2026-08-25T00:00:00  refs/heads/feature/fix  abc123456789' ;;
  "cert show") [ "$3" = "z6MkOwner/example" ] || exit 1; printf '%s\\n' 'Signature verification:' '  VALID' ;;
  *) exit 1 ;;
esac`);
  executable("git", `
if [ "$1" = "ls-remote" ]; then
  printf '%s\\n' 'abc1234567890000000000000000000000000000 refs/heads/feature/fix'
else
  exit 1
fi`);
  // The node is reached with fetch, so it is mocked here rather than stubbed as
  // a curl executable on PATH. The test no longer depends on an external binary.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/pulls/1")) {
      return jsonResponse({
        number: 1,
        source_branch: "feature/fix",
        target_branch: "main",
        status: "open"
      });
    }
    if (url.endsWith("/certs")) {
      return jsonResponse({
        certificates: [{
          id: "abcdef12",
          ref_name: "refs/heads/feature/fix",
          new_sha: "abc1234567890000000000000000000000000000"
        }]
      });
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  process.env.PATH = originalPath;
  vi.unstubAllGlobals();
});

describe("GitLawb adapter", () => {
  it("parses repository remotes", () => {
    expect(parseGitLawbRemote("gitlawb://did:key:z6MkOwner/example")).toEqual({
      owner: "did:key:z6MkOwner",
      repository: "example"
    });
  });

  it("reads repositories and UUID issues", () => {
    expect(getGitLawbRepository("z6MkOwner/example")).toMatchObject({
      platform: "gitlawb",
      nameWithOwner: "z6MkOwner/example",
      defaultBranch: "main"
    });
    expect(getGitLawbIssue("issue-id", "z6MkOwner/example")).toMatchObject({
      id: "issue-id",
      title: "Fix adapter",
      body: "Acceptance criteria\n- [ ] Tests pass"
    });
  });

  it("reads pull requests and verifies signed pushes", async () => {
    const pullRequest = await getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1");
    expect(pullRequest).toMatchObject({
      number: 1,
      state: "OPEN",
      headRef: "feature/fix",
      baseRef: "main",
      headSha: "abc1234567890000000000000000000000000000"
    });
    expect(await getGitLawbVerificationChecks(pullRequest)).toEqual([
      { name: "Signed push certificate", state: "verified", bucket: "pass" }
    ]);
  });

  it("refuses to trust a plaintext GitLawb node", async () => {
    const node = process.env.GITLAWB_NODE;
    try {
      process.env.GITLAWB_NODE = "http://node.example.com";
      await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
        .rejects.toThrow(/must use https/);

      process.env.GITLAWB_NODE = "not a url";
      await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
        .rejects.toThrow(/not a valid URL/);
    } finally {
      if (node === undefined) delete process.env.GITLAWB_NODE;
      else process.env.GITLAWB_NODE = node;
    }
  });

  it("allows a loopback node for local development", async () => {
    const node = process.env.GITLAWB_NODE;
    try {
      process.env.GITLAWB_NODE = "http://localhost:8080";
      await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
        .resolves.toMatchObject({ number: 1, state: "OPEN" });
    } finally {
      if (node === undefined) delete process.env.GITLAWB_NODE;
      else process.env.GITLAWB_NODE = node;
    }
  });

  it("follows an https redirect the way curl was told to", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://node.gitlawb.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://moved.gitlawb.com/api/v1/x/pulls/1" }
        });
      }
      return jsonResponse({
        number: 1,
        source_branch: "feature/fix",
        target_branch: "main",
        status: "open"
      });
    }));

    await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
      .resolves.toMatchObject({ number: 1 });
  });

  it("refuses a redirect that would downgrade the connection", async () => {
    // curl enforced this with --proto-redir =https. A node that can be pushed
    // off https chooses the verification result, which decides settlement.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://evil.example/api/v1/x/pulls/1" }
    })));

    await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
      .rejects.toThrow(/not secure/);
  });

  it("stops after too many redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://node.gitlawb.com/api/v1/x/pulls/1" }
    })));

    await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
      .rejects.toThrow(/too many times/);
  });

  it("reports a node that never answers instead of hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }));

    await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
      .rejects.toThrow(/did not respond within 30 seconds/);
  });

  it("reports a failing status rather than parsing the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    await expect(getGitLawbPullRequest("gitlawb://did:key:z6MkOwner/example/pull/1"))
      .rejects.toThrow(/status 503/);
  });

  it("rejects an issue reference that would read as a flag", () => {
    expect(() => getGitLawbIssue("--dir=/etc", "z6MkOwner/example"))
      .toThrow(/Invalid GitLawb issue reference/);
  });
});
