# Fork patches

Changes this fork carries on top of upstream T3 Code. The nightly merge agent reads this file after
every merge and checks each entry against the built server, the way the entry says.

## preview_fill_credential

New preview tool that fills a saved login from the user's keychain service
(`bitwarden-agent-keychain`) into a
server browser tab. The agent never sees the password or code.

Files: `apps/server/src/preview/credentialFill.ts`, `apps/server/src/preview/KeychainClient.ts`, and
small hooks marked `Fork:` in `packages/contracts/src/previewAutomation.ts`,
`apps/server/src/mcp/toolkits/preview/{tools,handlers}.ts`, `apps/server/src/preview/ServerBrowser.ts`
and `ServerBrowserPage.ts` (`targetLocator` is exported). `agentContextBudget.json` carries the larger
tool list.

Configured by `T3_KEYCHAIN_URL` and `T3_KEYCHAIN_TOKEN_FILE` in the server's environment. The keychain
answers `POST /v1/credential {url, kind, itemId?}` and does the site check itself.

Still works if:

- `credentialFill.test.ts` and the ownership test in `ServerBrowser.test.ts` pass.
- On a built server, an agent can log into a local test page with a dummy login, and the password
  shows up in no preview tool output: snapshot, status, wait_for, evaluate.
- A fill on a page whose site doesn't match the saved login is refused, and nothing is typed.
- `preview_evaluate` is refused after a fill until a new page loads, and a fill is refused on a page
  where `preview_evaluate` already ran.
- Snapshots still show password fields as dots (upstream behavior this relies on).

## Claude MCP elicitation choices

On Claude threads, an MCP elicitation form that spells out a one-time choice (an enum or `oneOf`
value such as `once` or `allow_once`) gets its buttons from the form, the way Codex threads already
do (`describeMcpElicitation`). `always` adds an "Always allow" button that sends `always` back in the
form content, and leaving it out hides the button. An approval server can then save Always itself
and refuse to offer it on risky requests. Upstream always shows Cancel / Decline / Always allow this
session / Approve, and both allow buttons send the same answer, so the server can't tell them apart.

Forms without a one-time choice (Computer Use and the like) keep upstream's fixed buttons and T3's
session grant. Picking a form's own `session` choice sends `session` and also records T3's grant.
Always records no grant, because the server keeps it.

Files: `claudeMcpElicitationOptions` and the `decision` parameter of
`claudeMcpElicitationAcceptance` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
with `Fork:` hooks in its `onElicitationEffect`. `mcpElicitationOffersOneTimeChoice` and the
wider `describeMcpElicitation` input type are in `apps/server/src/provider/CodexMcpElicitation.ts`.

Still works if:

- The `MCP elicitation` tests in `ClaudeAdapterV2.test.ts` and `CodexMcpElicitation.test.ts` pass.
- On a built server, in a Claude thread, an MCP tool that elicits with
  `{decision: {type: "string", enum: ["once", "always"]}}` shows Cancel / Decline / Always allow /
  Approve, and Always returns `{decision: "always"}`. With `enum: ["once"]` there is no Always button.
- An elicitation with an empty form still shows "Always allow this session", and a repeat of the
  same message after it is answered without a card.
