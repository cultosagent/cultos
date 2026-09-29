import { describe, expect, it } from "vitest";
import type { CultJob } from "../src/state.js";
import { evaluateDelivery, evaluateReviewDelivery, verdictIsClean } from "../src/verify.js";

const job: CultJob = {
  issueNumber: 42,
  repository: "thecultos/example",
  contract: {
    kind: "cultos.github.issue.v1",
    repository: "https://github.com/thecultos/example",
    issue: "https://github.com/thecultos/example/issues/42",
    baseRef: "main",
    title: "Fix wallet balance parsing",
    acceptanceCriteria: ["Tests pass"],
    delivery: { type: "github.pull_request" }
  },
  provider: "0x1234",
  jobId: "813",
  chainId: 8453,
  status: "submitted",
  delivery: {
    kind: "cultos.github.pull-request.v1",
    url: "https://github.com/thecultos/example/pull/47",
    headSha: "abc123456789"
  },
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z"
};

describe("evaluateDelivery", () => {
  it("accepts an unchanged pull request with passing checks", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47",
        state: "OPEN",
        headSha: "abc123456789",
        baseRef: "main"
      },
      [{ name: "test", state: "SUCCESS", bucket: "pass" }]
    );

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects a delivery that changed after submission", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47",
        state: "OPEN",
        headSha: "different123",
        baseRef: "main"
      },
      [{ name: "test", state: "FAILURE", bucket: "fail" }]
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Pull request changed after delivery");
    expect(result.failures).toContain("test: fail");
  });

  it("rejects a pull request URL outside the repository route", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47/commits",
        state: "OPEN",
        headSha: "abc123456789",
        baseRef: "main"
      },
      [{ name: "test", state: "SUCCESS", bucket: "pass" }]
    );

    expect(result.failures).toContain("Pull request belongs to a different repository");
  });

  it("explains that verification runs before merge", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47",
        state: "MERGED",
        headSha: "abc123456789",
        baseRef: "main"
      },
      [{ name: "test", state: "SUCCESS", bucket: "pass" }]
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Pull request is already merged; verify before merging");
  });

  it("re-verifies a merged delivery for settlement", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47",
        state: "MERGED",
        headSha: "abc123456789",
        baseRef: "main"
      },
      [{ name: "test", state: "SUCCESS", bucket: "pass" }],
      "MERGED"
    );

    expect(result.passed).toBe(true);
  });

  it("requires CI checks", () => {
    const result = evaluateDelivery(
      job,
      {
        number: 47,
        url: "https://github.com/thecultos/example/pull/47",
        state: "OPEN",
        headSha: "abc123456789",
        baseRef: "main"
      },
      []
    );

    expect(result.failures).toContain("Pull request has no CI checks");
  });
});

describe("evaluateReviewDelivery", () => {
  const reviewJob: CultJob = {
    issueNumber: 42,
    service: "review",
    repository: "thecultos/example",
    contract: {
      kind: "cultos.github.review.v1",
      repository: "https://github.com/thecultos/example",
      issue: "https://github.com/thecultos/example/issues/42",
      pullRequest: "https://github.com/thecultos/example/pull/47",
      headSha: "a".repeat(40),
      delivery: { type: "aeon.review" }
    },
    provider: "0x1234",
    jobId: "814",
    chainId: 8453,
    status: "submitted",
    delivery: {
      schema: "cultos.aeon.review.v1",
      status: "complete",
      repository: "thecultos/example",
      issue: 42,
      pull_request: 47,
      head_sha: "a".repeat(40),
      verdict: "blocked",
      summary: "A material defect was found.",
      findings: [{
        severity: "high",
        path: "src/index.ts",
        line: 12,
        title: "Incorrect branch",
        consequence: "The wrong state is returned."
      }],
      reviewed_files: ["src/index.ts"],
      limitations: [],
      run: {
        id: 91,
        url: "https://github.com/cultosdev/aeon/actions/runs/91",
        model: "anthropic/claude-sonnet-4",
        gateway: "openrouter",
        usage: { input_tokens: 10, output_tokens: 20 }
      }
    },
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z"
  };

  // The verdict is the reviewer's conclusion about the pull request, not a
  // statement about the review itself. A review that concludes "blocked" did
  // its job and gets paid, so it passes verification. This assertion is the
  // only place that decision was recorded; verdictIsClean and the CLI now say
  // it out loud as well.
  it("passes a blocked review: the verdict is not a verification failure", () => {
    const result = evaluateReviewDelivery(reviewJob, {
      number: 47,
      url: "https://github.com/thecultos/example/pull/47",
      state: "OPEN",
      headSha: "a".repeat(40),
      baseRef: "main"
    });

    expect(result.passed).toBe(true);
    expect(result.verdict).toBe("blocked");
    expect(result.findings).toHaveLength(1);
  });

  it("rejects a review after the pull request changes", () => {
    const result = evaluateReviewDelivery(reviewJob, {
      number: 47,
      url: "https://github.com/thecultos/example/pull/47",
      state: "OPEN",
      headSha: "b".repeat(40),
      baseRef: "main"
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Pull request changed after review");
  });
});

describe("what verification reports but cannot decide", () => {
  const passingPullRequest = {
    number: 47,
    url: "https://github.com/thecultos/example/pull/47",
    state: "OPEN",
    headSha: "abc123456789",
    baseRef: "main"
  };
  const passingChecks = [{ name: "test", state: "SUCCESS", bucket: "pass" }];

  it("carries the agreed criteria through to the result", () => {
    const result = evaluateDelivery(job, passingPullRequest, passingChecks);

    expect(result.acceptanceCriteria).toEqual(["Tests pass"]);
  });

  it("does not let the criteria change the outcome", () => {
    // They are free text from the issue, so CultOS reports them for a human to
    // read and never decides them. Verification has to stay deterministic.
    const withMany: CultJob = {
      ...job,
      contract: {
        ...job.contract,
        kind: "cultos.github.issue.v1",
        acceptanceCriteria: ["Tests pass", "Docs updated", "Nothing was actually done"]
      } as CultJob["contract"]
    };

    const result = evaluateDelivery(withMany, passingPullRequest, passingChecks);

    expect(result.passed).toBe(true);
    expect(result.acceptanceCriteria).toHaveLength(3);
  });

  it("reports an empty list rather than omitting it", () => {
    const withNone: CultJob = {
      ...job,
      contract: { ...job.contract, acceptanceCriteria: [] } as CultJob["contract"]
    };

    expect(evaluateDelivery(withNone, passingPullRequest, passingChecks).acceptanceCriteria)
      .toEqual([]);
  });

  it("treats only approve-ready as a clean verdict", () => {
    expect(verdictIsClean("approve-ready")).toBe(true);
    expect(verdictIsClean("discussion-needed")).toBe(false);
    expect(verdictIsClean("blocked")).toBe(false);
  });
});
