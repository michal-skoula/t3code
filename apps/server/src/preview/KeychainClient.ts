// @effect-diagnostics nodeBuiltinImport:off - the token file is read per request from Playwright code.

/**
 * Fork: client for the user's keychain service. The keychain checks `url` against the
 * item's saved URIs before it returns a secret. Configured by T3_KEYCHAIN_URL and
 * T3_KEYCHAIN_TOKEN_FILE; the token is read per request so it can rotate.
 */

import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeFSP from "node:fs/promises";

export type CredentialKind = "login" | "totp";

export interface CredentialRequest {
  readonly url: string;
  readonly kind: CredentialKind;
  readonly itemId?: string | undefined;
}

export interface Credential {
  readonly username?: string | null | undefined;
  readonly password?: string | null | undefined;
  readonly code?: string | undefined;
}

export interface KeychainClient {
  readonly resolve: (request: CredentialRequest) => Promise<Credential>;
}

/** Carries only fixed, secret-free text. */
export class KeychainError extends Schema.TaggedError<KeychainError>()("KeychainError", {
  message: Schema.String,
}) {}

export const isKeychainError = Schema.is(KeychainError);

const CredentialResponse = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
  password: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.String),
});

const ConflictResponse = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const decodeConflict = Schema.decodeUnknownOption(ConflictResponse);
const decodeCredential = Schema.decodeUnknownEffect(CredentialResponse);

const REQUEST_TIMEOUT = "20 seconds";

const statusMessage = (status: number): string => {
  if (status === 401) return "The keychain rejected T3's token. Check T3_KEYCHAIN_TOKEN_FILE.";
  if (status === 403) return "The saved login is not for this site, so nothing was filled.";
  if (status === 404) return "No saved login matches this site, so nothing was filled.";
  if (status === 423) return "The keychain is locked. Ask the user to unlock it.";
  return `The keychain answered ${status}, so nothing was filled.`;
};

const fail = (message: string) => Effect.fail(new KeychainError({ message }));

const resolveEffect = (config: { readonly url: string; readonly tokenFile: string }) =>
  Effect.fn("KeychainClient.resolve")(function* (request: CredentialRequest) {
    const token = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(config.tokenFile, "utf8"),
      catch: () => new KeychainError({ message: "T3 cannot read the keychain token file." }),
    });
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(new URL("/v1/credential", config.url)).pipe(
      HttpClientRequest.bearerToken(token.trim()),
      HttpClientRequest.bodyJsonUnsafe(request),
      client.execute,
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        () =>
          new KeychainError({
            message: "The keychain service is not reachable. Ask the user to start it.",
          }),
      ),
    );
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status === 409) {
      const names = Option.match(decodeConflict(body), {
        onNone: () => "ask the user which one",
        onSome: ({ items }) =>
          items
            .slice(0, 5)
            .map((item) => `${item.name} (${item.id})`)
            .join(", "),
      });
      return yield* fail(`Several saved logins match this site. Call again with itemId: ${names}.`);
    }
    if (response.status < 200 || response.status >= 300)
      return yield* fail(statusMessage(response.status));
    return yield* decodeCredential(body).pipe(
      Effect.mapError(
        () => new KeychainError({ message: "The keychain returned an unreadable answer." }),
      ),
    );
  });

const make = (config: { readonly url: string; readonly tokenFile: string }): KeychainClient => {
  const resolve = resolveEffect(config);
  return {
    resolve: (request) =>
      Effect.runPromiseExit(resolve(request).pipe(Effect.provide(FetchHttpClient.layer))).then(
        (exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause))),
      ),
  };
};

const unconfigured: KeychainClient = {
  resolve: () =>
    Promise.reject(
      new KeychainError({
        message:
          "No keychain is configured for this T3 server (T3_KEYCHAIN_URL and T3_KEYCHAIN_TOKEN_FILE).",
      }),
    ),
};

export const fromEnvironment = Effect.gen(function* () {
  const url = yield* Config.String("T3_KEYCHAIN_URL").pipe(Config.option);
  const tokenFile = yield* Config.String("T3_KEYCHAIN_TOKEN_FILE").pipe(Config.option);
  return Option.isSome(url) && Option.isSome(tokenFile)
    ? make({ url: url.value, tokenFile: tokenFile.value })
    : unconfigured;
}).pipe(Effect.orElseSucceed(() => unconfigured));
