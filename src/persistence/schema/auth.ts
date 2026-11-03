// Owner: src/platform/auth. Only src/platform/auth's Better Auth adapter writes these tables
// (WEBAPP_TEMPLATE_SPEC.md §5.7 "only the owner writes"; decisions/0005-better-auth-magic-link-drizzle-adapter.md).
//
// The shape Better Auth's Drizzle adapter (`drizzleAdapter(db, { provider: "pg",
// schema: authSchema })`, decisions/0005) expects for `user`, `session`, `account`,
// `verification`, and its database-backed rate limiter (`rateLimit: { storage:
// "database" }`, WEBAPP_TEMPLATE_SPEC.md §6.3). IDs are UUID (`advanced.database.generateId:
// "uuid"`), matching every other owner's tables.
//
// Better Auth queries unqualified, case-sensitive table/column names (`"user"`,
// `"emailVerified"`, …): Postgres folds unquoted identifiers to lowercase, so every
// table and every column here is quoted camelCase in the database. Every column
// below carries an EXPLICIT database name matching that exactly, so this schema's
// behavior does not depend on `casing: "snake_case"` (src/persistence/foundation/client.ts)
// at runtime: that option only fills in a name when a column has none.
//
// Do not rename columns/tables here without re-checking against a fresh Better Auth
// CLI run (`pnpm dlx @better-auth/cli generate`, WEBAPP_TEMPLATE_SPEC.md §6.2): an
// accidental rename would silently desync this file from what the adapter actually
// writes.
import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

export const user = authSchema.table("user", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export const session = authSchema.table(
  "session",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = authSchema.table(
  "account",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = authSchema.table(
  "verification",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Better Auth's database-backed rate limiter (`rateLimit: { storage: "database" }`,
// WEBAPP_TEMPLATE_SPEC.md §6.3): survives serverless cold starts, works across
// multiple function instances, unlike an in-memory or Redis-backed limiter.
export const rateLimit = authSchema.table("rateLimit", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("lastRequest", { mode: "number" }).notNull(),
});

// ---------------------------------------------------------------------------------------
// decisions/0078-mcp-server.md: the OAuth 2.1 authorization server behind the remote MCP
// server (`/api/mcp`). Tables for Better Auth's `jwt()` (signing keys), `mcp()` (=
// `@better-auth/oauth-provider`: clients, resources, consents, access/refresh tokens) and
// `cimd()` (client assertion replay guard) plugins, at better-auth 1.7.12. Generated with the
// Better Auth CLI against this exact plugin set and translated to this file's conventions
// (`auth` schema, quoted camelCase identifiers, timestamptz, uuid ids). Model keys must match
// Better Auth's model names exactly. Every user-owned row cascades from `user.id`, every
// client-owned row from `oauthClient.clientId`, so deleting an account or a client leaves
// nothing behind. None of these is workspace-owned: a grant belongs to a person, and which
// workspace a call acts in is decided per request (`src/platform/access`'s `resolveAccess`).
// ---------------------------------------------------------------------------------------

export const jwks = authSchema.table("jwks", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = authSchema.table(
  "oauthClient",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    clientDiscoveryId: text("clientDiscoveryId"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("clientCredentialsScopes").array().default([]),
    userId: uuid("userId").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: text("redirectUris").array().notNull(),
    postLogoutRedirectUris: text("postLogoutRedirectUris").array(),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: boolean("backchannelLogoutSessionRequired"),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    applicationType: text("applicationType"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: text("grantTypes").array(),
    responseTypes: text("responseTypes").array(),
    requirePKCE: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean("dpopBoundAccessTokens").default(false),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauthClient_userId_idx").on(t.userId)],
);

export const oauthResource = authSchema.table("oauthResource", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes").array(),
  customClaims: jsonb("customClaims"),
  dpopBoundAccessTokensRequired: boolean("dpopBoundAccessTokensRequired").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("createdAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }),
  policyVersion: integer("policyVersion").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = authSchema.table(
  "oauthClientResource",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(t.clientId, t.resourceId),
    index("oauthClientResource_clientId_idx").on(t.clientId),
    index("oauthClientResource_resourceId_idx").on(t.resourceId),
  ],
);

export const oauthRefreshToken = authSchema.table(
  "oauthRefreshToken",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: uuid("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotatedAt", { withTimezone: true }),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: timestamp("rotationReplayExpiresAt", { withTimezone: true }),
    authTime: timestamp("authTime", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthRefreshToken_clientId_idx").on(t.clientId),
    index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
    index("oauthRefreshToken_userId_idx").on(t.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = authSchema.table(
  "oauthAccessToken",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: uuid("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: uuid("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    refreshId: uuid("refreshId").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    revoked: timestamp("revoked", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_sessionId_idx").on(t.sessionId),
    index("oauthAccessToken_userId_idx").on(t.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(t.authorizationCodeId),
    index("oauthAccessToken_refreshId_idx").on(t.refreshId),
  ],
);

export const oauthConsent = authSchema.table(
  "oauthConsent",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: uuid("userId").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requestedUserInfoClaims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("oauthConsent_clientId_idx").on(t.clientId), index("oauthConsent_userId_idx").on(t.userId)],
);

export const oauthClientAssertion = authSchema.table("oauthClientAssertion", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
});

/**
 * decisions/0078-mcp-server.md: our own table, not Better Auth's - one row per (user, OAuth
 * client) that has called `/api/mcp`. `lastUsedAt` is what "Verbundene KI-Anwendungen" shows
 * as the last use; `windowStartedAt`/`windowCount` are the fixed-window per-user-per-client
 * rate limit. Both are written by the one atomic upsert every authenticated MCP request makes
 * (`src/persistence/composition/auth-database.ts`'s `recordMcpRequest`). Cascades from both the
 * user and the client, so a deleted account or client leaves no row behind; revoking a grant
 * deletes it explicitly (`revokeOAuthGrant`).
 */
export const mcpClientUsage = authSchema.table(
  "mcpClientUsage",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true }).notNull(),
    windowStartedAt: timestamp("windowStartedAt", { withTimezone: true }).notNull(),
    windowCount: integer("windowCount").notNull(),
  },
  (t) => [primaryKey({ name: "mcpClientUsage_pkey", columns: [t.userId, t.clientId] }), index("mcpClientUsage_clientId_idx").on(t.clientId)],
);
