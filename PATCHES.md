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
