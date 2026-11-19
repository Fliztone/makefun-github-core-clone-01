# makefun-github-core-clone-01 — a GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fliztone/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fliztone/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process, one in-memory store, no UI,
no dependencies, no outside services. It serves the four surfaces a GitHub client expects,
all backed by the same repositories, objects, issues and pull requests:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`, `fetch` with shallow
  and deepen semantics) and the v0 fallback, plus `receive-pack` v0 with per-ref
  fast-forward validation, `report-status` and `side-band-64k`. Real SHA-1 object database:
  packfiles in (plain objects and both delta forms) and out, byte-exact round trips.
- **REST v3** under `/api/v3` — repositories, the contents API (every write is a real git
  commit), branches, commits, git refs, labels, issues, comments, and pull requests with a
  three-way-merge squash/merge/rebase. GitHub status codes, JSON error bodies, `Link`
  pagination and `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql` — a real parser and executor (variables, aliases,
  inline fragments, enums, input objects, batching) over a schema with the `viewer`,
  `repository`, `node`, issue and pull-request reads, the `createIssue`/`closeIssue`/
  `createPullRequest`/`mergePullRequest`/`addComment` mutations, and the `__type`
  introspection `gh` feature-detects.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake as fallback. Six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same store, so objects created over MCP read back
  identically over REST.

## Design notes

- **One store, four surfaces.** A repository holds a git object database and refs alongside
  its issues, pulls, labels and comments. A commit made through the contents API is the
  same kind of object a push delivers; a clone serves either.
- **Deterministic by construction.** No wall clock and no randomness in any answer:
  timestamps walk a counter from `MAKEFUN_TRIAL_NOW`, ids walk counters, object ids are
  SHA-1 of content. Two runs on the same inputs answer byte-identically.
- **Fast where it is measured.** Git advertisements, `ls-refs` and framed fetch responses
  are cached as whole wire buffers keyed by the repo's git version and the exact request
  bytes, so concurrent clones of one tip answer from memory; issue reads answer from a
  cached serialized buffer invalidated on change; bodyless GETs skip the stream machinery.
- **Boot protocol.** Binds an ephemeral port of its own (never 8080), POSTs
  `{"port": N}` to `$MAKEFUN_ENV_URL/register`, answers `GET /healthz`, then polls
  `$MAKEFUN_ENV_URL/done` and exits 0 when the suite is over.

## Layout

| File | Role |
| --- | --- |
| `main.ts` | entrypoint: the entry ↔ env lifecycle |
| `forge.ts` | HTTP server, routing, bearer auth, request ids |
| `store.ts` | the shared store, deterministic clock and ids |
| `gitobj.ts` | git object model, pack/pkt-line codecs, tree merge |
| `githttp.ts` | smart HTTP: v2/v0 upload-pack, receive-pack |
| `rest.ts` | REST v3 surface |
| `graphql.ts` | GraphQL parser, schema, executor, introspection |
| `mcp.ts` | MCP JSON-RPC endpoint and tools |

## Running

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Node 22+ (erasable TypeScript only, standard library only). Licensed MIT.
