# makefun-github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fliztone/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fliztone/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge built for the [make.fun](https://make.fun) bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). One Node 22 process,
standard library only, serving four surfaces from one in-memory store:

- **git smart HTTP** — upload-pack protocol v2 (v0 fallback) and receive-pack v0 at `/{owner}/{repo}.git`
- **REST v3** — repositories, branches, commits, contents, labels, issues, comments and pull requests under `/api/v3`
- **GraphQL v4** — the documents `gh` and `github-mcp-server` send, at `/api/graphql`
- **MCP** — JSON-RPC 2.0 over streamable HTTP at `/mcp`

## Run

The entry follows the contest lifecycle: it binds an ephemeral port, registers it with the
env at `$MAKEFUN_ENV_URL`, serves the suite, and exits 0 when the env says done.

```sh
node main.ts
```

Local grading with the contest kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

## Design

All state is in memory and deterministic: timestamps come from `MAKEFUN_TRIAL_NOW`, ids are
sequential, and git objects are content-addressed and stored byte for byte, so a replay of a
trial leaves the same state export. No wall clock, no unseeded randomness, no network beyond
the env, no git binary — the pack protocol is implemented on `node:zlib` and `node:crypto`.