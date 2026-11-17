// @effect-diagnostics globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

/**
 * Fork: fills a saved login into a preview tab without the agent seeing it. Fill, submit,
 * then wait for the secret to leave the page; if the form stays, wipe the field. Only real
 * password fields, only after the keychain's origin check, never into GET forms.
 */

import type {
  PreviewAutomationFillCredentialInput,
  PreviewAutomationFillCredentialResult,
} from "@t3tools/contracts";
import type { Frame, Locator, Page } from "playwright-core";

import * as Schema from "effect/Schema";

import { isKeychainError, type Credential, type KeychainClient } from "./KeychainClient.ts";
import { ServerBrowserOperationError, targetLocator } from "./ServerBrowserPage.ts";

const SETTLE_MS = 10_000;
const ACTION_TIMEOUT_MS = 5_000;

type Filled = PreviewAutomationFillCredentialResult["filled"][number];

interface Field {
  readonly locator: Locator;
  readonly frame: Frame;
}

interface FieldInfo {
  readonly tag: string;
  readonly type: string;
  readonly editable: boolean;
  readonly maxLength: number;
  /** The form's method attribute, lowercased; null outside a form or when unset. */
  readonly formMethod: string | null;
}

/** The DOM shapes the page functions touch; the server has no DOM types. */
interface DomInput {
  readonly tagName: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly autocomplete: string;
  readonly inputMode: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly maxLength: number;
  readonly isConnected: boolean;
  readonly form: { getAttribute(name: string): string | null } | null;
  value: string;
  getAttribute(name: string): string | null;
  getClientRects(): { readonly length: number };
  dispatchEvent(event: unknown): boolean;
}

const isServerBrowserOperationError = Schema.is(ServerBrowserOperationError);

const fail = (message: string) =>
  new ServerBrowserOperationError({ tag: "PreviewAutomationExecutionError", message });

/** Runs a Playwright step and replaces any error with fixed text, so no page or secret content escapes. */
const step = async <A>(message: string, run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (cause) {
    if (isServerBrowserOperationError(cause)) throw cause;
    throw fail(message);
  }
};

const fromRef = async (page: Page, ref: string): Promise<Field> => {
  const locator = targetLocator(page, { locator: ref });
  if (locator === null) throw fail("A locator was empty.");
  const frame = await step("A locator matched no element. Take a fresh snapshot.", async () => {
    const handle = await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS });
    try {
      return await handle.ownerFrame();
    } finally {
      await handle.dispose();
    }
  });
  if (!frame) throw fail("A locator matched no element. Take a fresh snapshot.");
  return { locator, frame };
};

const inspect = (field: Field): Promise<FieldInfo> =>
  step("A field could not be read.", () =>
    field.locator.evaluate(
      (element: unknown) => {
        const input = element as DomInput;
        const form = input.form ?? null;
        return {
          tag: input.tagName,
          type: (input.type ?? "").toLowerCase(),
          editable: !input.disabled && !input.readOnly,
          maxLength: typeof input.maxLength === "number" ? input.maxLength : -1,
          formMethod: form?.getAttribute("method")?.toLowerCase() ?? null,
        };
      },
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    ),
  );

const TEXT_TYPES = new Set(["text", "email", "tel", ""]);
const CODE_TYPES = new Set(["text", "tel", "number", ""]);

// Serialized into the page, so it must not reference module scope.
const detectLoginFields = (elements: unknown[]) => {
  const list = elements as DomInput[];
  const style = (globalThis as unknown as { getComputedStyle(el: unknown): { visibility: string } })
    .getComputedStyle;
  const usable = (el: DomInput) =>
    !el.disabled &&
    !el.readOnly &&
    el.getClientRects().length > 0 &&
    style(el).visibility !== "hidden";
  const label = (el: DomInput) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label") ?? "", el.autocomplete].join(
      " ",
    );
  const passwords = list
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => el.type === "password" && usable(el));
  const current =
    passwords.find(({ el }) => el.autocomplete === "current-password") ??
    passwords.find(({ el }) => el.autocomplete !== "new-password") ??
    passwords[0];
  const password = current ? current.index : -1;
  const textTypes = ["text", "email", "tel", ""];
  let username = -1;
  let best = -Infinity;
  list.forEach((el, index) => {
    if (!textTypes.includes(el.type) || !usable(el)) return;
    if (password >= 0 && index >= password) return;
    const text = label(el);
    if (/search|query|coupon|promo/i.test(text)) return;
    let score = 0;
    if (el.autocomplete === "username") score += 10;
    if (el.type === "email" || el.autocomplete === "email") score += 5;
    if (/user|login|e-?mail|account|identifier|handle/i.test(text)) score += 4;
    if (password >= 0) {
      if (list[password]!.form && el.form === list[password]!.form) score += 3;
      score += index / 1000;
    }
    if (password < 0 && score <= 0) return;
    if (score > best) {
      best = score;
      username = index;
    }
  });
  return { username, password };
};

// Serialized into the page, so it must not reference module scope.
const detectCodeField = (elements: unknown[]) => {
  const list = elements as DomInput[];
  const usable = (el: DomInput) =>
    !el.disabled &&
    !el.readOnly &&
    el.getClientRects().length > 0 &&
    ["text", "tel", "number", ""].includes(el.type);
  const singles = list
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => usable(el) && el.maxLength === 1);
  if (singles.length >= 4) return singles[0]!.index;
  let found = -1;
  let best = 0;
  list.forEach((el, index) => {
    if (!usable(el)) return;
    const text = [el.name, el.id, el.placeholder, el.getAttribute("aria-label") ?? ""].join(" ");
    let score = 0;
    if (el.autocomplete === "one-time-code") score += 10;
    if (/otp|totp|2fa|mfa|one.?time|verif|auth.?code|security.?code|\bcode\b|token|pin/i.test(text))
      score += 5;
    if (el.inputMode === "numeric" || el.type === "tel" || el.type === "number") score += 2;
    if (el.maxLength >= 6 && el.maxLength <= 8) score += 2;
    if (score > best) {
      best = score;
      found = index;
    }
  });
  return best >= 4 ? found : -1;
};

const detectLogin = async (page: Page) => {
  let fallback: { username: Field | null; password: Field | null } | null = null;
  for (const frame of page.frames()) {
    const inputs = frame.locator("input");
    const found = await inputs.evaluateAll(detectLoginFields).catch(() => null);
    if (!found) continue;
    const result = {
      username: found.username >= 0 ? { locator: inputs.nth(found.username), frame } : null,
      password: found.password >= 0 ? { locator: inputs.nth(found.password), frame } : null,
    };
    if (result.password) return result;
    if (result.username && !fallback) fallback = result;
  }
  return fallback ?? { username: null, password: null };
};

const detectCode = async (page: Page): Promise<Field | null> => {
  for (const frame of page.frames()) {
    const inputs = frame.locator("input");
    const index = await inputs.evaluateAll(detectCodeField).catch(() => -1);
    if (index >= 0) return { locator: inputs.nth(index), frame };
  }
  return null;
};

const frameUrl = (field: Field) => {
  const url = field.frame.url();
  if (!/^https?:\/\//i.test(url)) throw fail("Logins are only filled on http(s) pages.");
  return url;
};

const resolveCredential = async (
  keychain: KeychainClient,
  request: Parameters<KeychainClient["resolve"]>[0],
): Promise<Credential> => {
  try {
    return await keychain.resolve(request);
  } catch (cause) {
    throw fail(isKeychainError(cause) ? cause.message : "The keychain request failed.");
  }
};

const submit = async (
  page: Page,
  anchor: Field,
  submitRef: string | undefined,
): Promise<PreviewAutomationFillCredentialResult["submitted"]> => {
  if (submitRef !== undefined) {
    const button = await fromRef(page, submitRef);
    await step("The submit button could not be clicked.", () =>
      button.locator.click({ timeout: ACTION_TIMEOUT_MS }),
    );
    return "click";
  }
  const button = anchor.locator
    .locator("xpath=ancestor::form[1]")
    .locator("button[type=submit], input[type=submit], button:not([type])")
    .filter({ visible: true })
    .first();
  if ((await button.count().catch(() => 0)) > 0) {
    await step("The submit button could not be clicked.", () =>
      button.click({ timeout: ACTION_TIMEOUT_MS }),
    );
    return "click";
  }
  await step("Enter could not be pressed in the form.", () =>
    anchor.locator.press("Enter", { timeout: ACTION_TIMEOUT_MS }),
  );
  return "enter";
};

/** Submits, then waits for the secret to leave the page; wipes it if the form is still there. */
const submitAndSettle = async (
  page: Page,
  anchor: Field,
  secret: Field,
  submitRef: string | undefined,
  settleMs: number,
) => {
  const handle = await step("A field could not be read.", () =>
    secret.locator.elementHandle({ timeout: ACTION_TIMEOUT_MS }),
  );
  // null: the field's document is gone. Otherwise whether the field still holds the secret.
  const holdsSecret = () =>
    handle
      .evaluate((element: unknown) => {
        const input = element as DomInput;
        return input.isConnected && input.value !== "" && input.getClientRects().length > 0;
      })
      .catch(() => null);
  try {
    const submitted = await submit(page, anchor, submitRef);
    // A click waits for the navigation it starts to commit, so the page may have moved on already.
    const afterSubmit = await holdsSecret();
    if (afterSubmit === null || page.isClosed() || secret.frame.isDetached())
      return { submitted, outcome: "navigated" as const };
    if (!afterSubmit) return { submitted, outcome: "formGone" as const };
    const deadline = Date.now() + settleMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // waitForFunction keeps retrying across a navigation, so the frame's own navigation ends the wait.
      let onNavigated: ((frame: Frame) => void) | undefined;
      const navigated = new Promise<"navigated">((resolve) => {
        onNavigated = (frame) => {
          if (frame === secret.frame) resolve("navigated");
        };
        page.on("framenavigated", onNavigated);
      });
      const gone = secret.frame
        .waitForFunction(
          (element: unknown) => {
            const input = element as DomInput;
            return !input.isConnected || input.value === "" || input.getClientRects().length === 0;
          },
          handle,
          { timeout: remaining },
        )
        .then(
          () => "gone" as const,
          (cause: unknown) =>
            cause instanceof Error && cause.name === "TimeoutError"
              ? ("timeout" as const)
              : ("navigated" as const),
        );
      const winner = await Promise.race([gone, navigated]);
      page.off("framenavigated", onNavigated!);
      if (winner === "gone") return { submitted, outcome: "formGone" as const };
      if (winner === "timeout") break;
      const state = await holdsSecret();
      if (state === null || page.isClosed() || secret.frame.isDetached())
        return { submitted, outcome: "navigated" as const };
      if (!state) return { submitted, outcome: "formGone" as const };
      // A same-document navigation left the filled field in place: keep waiting.
    }
    const cleared = await handle
      .evaluate((element: unknown) => {
        const input = element as DomInput;
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })
      .catch(() => false);
    return { submitted, outcome: cleared ? ("cleared" as const) : ("navigated" as const) };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
};

const fillLogin = async (
  page: Page,
  input: PreviewAutomationFillCredentialInput,
  keychain: KeychainClient,
  settleMs: number,
): Promise<PreviewAutomationFillCredentialResult> => {
  const explicit = input.username !== undefined || input.password !== undefined;
  const { username, password } = explicit
    ? {
        username: input.username === undefined ? null : await fromRef(page, input.username),
        password: input.password === undefined ? null : await fromRef(page, input.password),
      }
    : await detectLogin(page);
  if (!username && !password) {
    throw fail(
      "No login fields found. Pass username and password as aria-ref locators from preview_snapshot.",
    );
  }
  if (password) {
    const info = await inspect(password);
    if (info.tag !== "INPUT" || info.type !== "password" || !info.editable)
      throw fail("The password target is not an editable password field, so nothing was filled.");
    if (info.formMethod === "get")
      throw fail("This form sends its fields in the URL (method=get), so nothing was filled.");
  }
  if (username) {
    const info = await inspect(username);
    if (info.tag !== "INPUT" || !TEXT_TYPES.has(info.type) || !info.editable)
      throw fail("The username target is not an editable text field, so nothing was filled.");
  }
  if (username && password && username.frame !== password.frame)
    throw fail("The username and password fields are in different frames, so nothing was filled.");

  const anchor = (password ?? username)!;
  const credential = await resolveCredential(keychain, {
    url: frameUrl(anchor),
    kind: "login",
    itemId: input.itemId,
  });

  const filled: Filled[] = [];
  if (username && credential.username) {
    await step("The username field could not be filled.", () =>
      username.locator.fill(credential.username!, { timeout: ACTION_TIMEOUT_MS }),
    );
    filled.push("username");
  }
  if (password && credential.password) {
    await step("The password field could not be filled.", () =>
      password.locator.fill(credential.password!, { timeout: ACTION_TIMEOUT_MS }),
    );
    filled.push("password");
  }
  if (filled.length === 0) throw fail("The saved login has nothing to fill into these fields.");

  if (!filled.includes("password")) {
    const submitted = await submit(page, anchor, input.submit);
    return { filled, submitted, outcome: "usernameOnly" };
  }
  const settled = await submitAndSettle(page, anchor, password!, input.submit, settleMs);
  return { filled, ...settled };
};

const fillCode = async (
  page: Page,
  input: PreviewAutomationFillCredentialInput,
  keychain: KeychainClient,
  settleMs: number,
): Promise<PreviewAutomationFillCredentialResult> => {
  const field = input.code === undefined ? await detectCode(page) : await fromRef(page, input.code);
  if (!field) throw fail("No one-time code field found. Pass code as an aria-ref locator.");
  const info = await inspect(field);
  if (info.tag !== "INPUT" || !CODE_TYPES.has(info.type) || !info.editable)
    throw fail("The code target is not an editable text field, so nothing was filled.");
  if (info.formMethod === "get")
    throw fail("This form sends its fields in the URL (method=get), so nothing was filled.");

  const credential = await resolveCredential(keychain, {
    url: frameUrl(field),
    kind: "totp",
    itemId: input.itemId,
  });
  if (!credential.code) throw fail("The saved login has no one-time code.");

  if (info.maxLength === 1) {
    // One box per digit: type into the first and let the page move focus along.
    await step("The code field could not be filled.", async () => {
      await field.locator.click({ timeout: ACTION_TIMEOUT_MS });
      await page.keyboard.type(credential.code!);
    });
    // Settles on the first box only; a code is single-use and expires within a minute.
    const settled = await submitAndSettle(page, field, field, input.submit, settleMs);
    return { filled: ["code"], ...settled };
  }
  await step("The code field could not be filled.", () =>
    field.locator.fill(credential.code!, { timeout: ACTION_TIMEOUT_MS }),
  );
  const settled = await submitAndSettle(page, field, field, input.submit, settleMs);
  return { filled: ["code"], ...settled };
};

export const fillCredential = (
  page: Page,
  input: PreviewAutomationFillCredentialInput,
  keychain: KeychainClient,
  options: { readonly settleMs?: number } = {},
): Promise<PreviewAutomationFillCredentialResult> =>
  step("The login could not be filled.", () =>
    (input.kind ?? "login") === "totp"
      ? fillCode(page, input, keychain, options.settleMs ?? SETTLE_MS)
      : fillLogin(page, input, keychain, options.settleMs ?? SETTLE_MS),
  );
