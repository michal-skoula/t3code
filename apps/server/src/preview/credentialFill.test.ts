// @effect-diagnostics nodeBuiltinImport:off - a plain HTTP fixture site for a real browser.

import * as NodeHttp from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { fillCredential } from "./credentialFill.ts";
import { KeychainError, type CredentialRequest, type KeychainClient } from "./KeychainClient.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const USER = "agent@example.com";
const PASSWORD = "Correct-Horse-9183!";
const CODE = "482913";

const page = (body: string) => `<!doctype html><title>t</title>${body}`;
const form = (inner: string, attributes = 'method="post" action="/session"') =>
  `<form ${attributes}>${inner}<button type="submit">Sign in</button></form>`;

const ROUTES: Record<string, string> = {
  "/login": page(
    form(`<label>Account <input name="acct"></label>
      <label>Search <input name="q" type="search"></label>
      <label>Password <input name="pw" type="password"></label>`),
  ),
  "/two-step": page(form(`<label>Email <input type="email" name="email"></label>`)),
  // Rejects every login and keeps what was typed on screen.
  "/stays": page(
    `<p id="err"></p>` +
      form(
        `<label>Username <input autocomplete="username" name="u"></label>
         <label>Password <input type="password" name="p"></label>`,
        `onsubmit="event.preventDefault(); err.textContent = 'Wrong password'"`,
      ),
  ),
  "/get-form": page(
    form(`<input name="u"><input type="password" name="p">`, 'method="get" action="/session"'),
  ),
  "/odd": page(
    form(`<label>Member number <input name="m"></label>
      <label>Secret word <input name="s" type="text"></label>
      <label>Real password <input name="pw" type="password"></label>`),
  ),
  "/totp": page(
    form(
      `<label>Code <input name="otc" autocomplete="one-time-code" inputmode="numeric"></label>`,
      'method="post" action="/code"',
    ),
  ),
  "/home": page("<p>Signed in</p>"),
};

describe("credential fill", () => {
  let server: NodeHttp.Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let tab: Page;
  let posted: URLSearchParams[];
  let requests: CredentialRequest[];

  const keychain = (
    answer: (
      request: CredentialRequest,
    ) => Promise<{ username?: string; password?: string; code?: string }> = async (request) =>
      request.kind === "totp" ? { code: CODE } : { username: USER, password: PASSWORD },
  ): KeychainClient => ({
    resolve: (request) => {
      requests.push(request);
      return answer(request);
    },
  });

  beforeAll(async () => {
    server = NodeHttp.createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          posted.push(new URLSearchParams(body));
          response.writeHead(303, { location: "/home" }).end();
        });
        return;
      }
      const html = ROUTES[path];
      response.writeHead(html ? 200 : 404, { "content-type": "text/html" }).end(html ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });
  beforeEach(async () => {
    posted = [];
    requests = [];
    context = await browser.newContext();
    tab = await context.newPage();
  });
  afterEach(async () => {
    await context.close();
  });

  it("detects the fields, asks the keychain with the frame URL, and submits", async () => {
    await tab.goto(`${origin}/login`);
    const result = await fillCredential(tab, {}, keychain());
    expect(result).toEqual({
      filled: ["username", "password"],
      submitted: "click",
      outcome: "navigated",
    });
    expect(requests).toEqual([{ url: `${origin}/login`, kind: "login", itemId: undefined }]);
    expect(Object.fromEntries(posted[0]!)).toMatchObject({ acct: USER, pw: PASSWORD, q: "" });
    expect(tab.url()).toBe(`${origin}/home`);
  });

  it("fills only the username on a username-first page", async () => {
    await tab.goto(`${origin}/two-step`);
    const result = await fillCredential(tab, { itemId: "item-1" }, keychain());
    expect(result).toEqual({ filled: ["username"], submitted: "click", outcome: "usernameOnly" });
    expect(requests[0]).toMatchObject({ itemId: "item-1" });
  });

  it("wipes the password when the form stays after submit", async () => {
    await tab.goto(`${origin}/stays`);
    const result = await fillCredential(tab, {}, keychain(), { settleMs: 500 });
    expect(result.outcome).toBe("cleared");
    expect(await tab.locator("input[name=p]").inputValue()).toBe("");
    expect(await tab.locator("#err").textContent()).toBe("Wrong password");
  });

  it("fills fields named by snapshot refs", async () => {
    await tab.goto(`${origin}/odd`);
    const cdp = await context.newCDPSession(tab);
    const snapshot = await ServerBrowserPage.snapshot({
      page: tab,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    const ref = (name: string) =>
      `aria-ref=${new RegExp(`textbox "${name}" \\[ref=([^\\]]+)\\]`).exec(String(snapshot.accessibilityTree))![1]}`;
    await fillCredential(
      tab,
      { username: ref("Member number"), password: ref("Real password") },
      keychain(),
    );
    expect(Object.fromEntries(posted[0]!)).toMatchObject({ m: USER, s: "", pw: PASSWORD });
  });

  it.each([
    [
      "a text field as the password",
      "/odd",
      { password: "input[name=s]" },
      "not an editable password field",
    ],
    ["a GET form", "/get-form", {}, "method=get"],
  ])("refuses %s before asking the keychain", async (_name, path, refs, message) => {
    await tab.goto(`${origin}${path}`);
    await expect(fillCredential(tab, refs, keychain())).rejects.toMatchObject({
      tag: "PreviewAutomationExecutionError",
      message: expect.stringContaining(message),
    });
    expect(requests).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("passes the keychain's refusal on and fills nothing", async () => {
    await tab.goto(`${origin}/login`);
    const refuse = keychain(() =>
      Promise.reject(
        new KeychainError({
          message: "The saved login is not for this site, so nothing was filled.",
        }),
      ),
    );
    await expect(fillCredential(tab, {}, refuse)).rejects.toMatchObject({
      message: "The saved login is not for this site, so nothing was filled.",
    });
    expect(await tab.locator("input[name=pw]").inputValue()).toBe("");
    expect(posted).toEqual([]);
  });

  it("fills an authenticator code", async () => {
    await tab.goto(`${origin}/totp`);
    const result = await fillCredential(tab, { kind: "totp" }, keychain());
    expect(result.filled).toEqual(["code"]);
    expect(requests[0]).toMatchObject({ kind: "totp" });
    expect(posted[0]!.get("otc")).toBe(CODE);
  });
});
