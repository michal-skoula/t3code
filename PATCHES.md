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

## Server browser render scale and GPU

Two opt-in settings for the server's headless Chrome, read from the T3 server's environment
(`~/.t3/service.env` on workbench). Unset, behavior matches upstream: `--disable-gpu`, scale 2.

- `T3CODE_SERVER_BROWSER_SCALE=1` renders tabs at device pixel ratio 1 instead of 2 (1 to 3
  allowed). Software rendering pays for every pixel, so 1 draws a quarter of them.
- `T3CODE_SERVER_BROWSER_GPU=1` drops `--disable-gpu` and runs ANGLE on Vulkan, so a GPU passed
  into the VM gets used. Without a usable GPU, Chrome falls back to SwiftShader.

Files: `PreviewBrowserHost.ts` (`renderScale`, `renderingArgs`), and lines marked
`Fork:` in `ServerBrowserContexts.ts` (launch args, context `deviceScaleFactor`) and
`ServerBrowser.ts` (`RENDER_SCALE` now comes from the environment, which is also passed to the
contexts).

Still works if:

- The `renderingArgs` tests in `PreviewBrowserHost.test.ts` pass.
- On a built server with neither variable set, a server tab reports `devicePixelRatio` 2 and a
  SwiftShader WebGL renderer.
- With `T3CODE_SERVER_BROWSER_SCALE=1`, `devicePixelRatio` is 1, and snapshots and zoom still line up
  with clicks.
