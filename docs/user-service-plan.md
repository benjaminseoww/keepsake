# User service plan

Status: superseded. The Fastify service in `backend/` was folded into the Next.js app (`client/lib/users.ts`) so the whole app deploys as one Next.js project. `POST /users` and `GET /auth/me` were dropped because nothing called them; see git history to restore `POST /users`.

## Scope

The user service owns **who someone is and what role they have**:

- Login (email + password) for the web client
- Who am I (`/auth/me`) and the household care team
- Admin-only user creation
- Issuing the JWT that the web client, the ElevenLabs agent and the memory service all trust

Out of scope: anything touching `memories`, which goes in a separate PR (see `docs/memory-service-plan.md`). Also out of scope: device pairing, preferred name, time-limited caregiver access, an audit trail for user changes, and multiple people per user.

## Decisions

| Area | Decision |
|---|---|
| Stack | Node + TypeScript (the project brief says Python/FastAPI; the team chose Node to match the Next.js client), Fastify + `fastify-type-provider-zod`, native `mongodb`, `bcryptjs`, `jose`, `vitest` + `mongodb-memory-server` |
| Location | `backend/`, a sibling of the web branch's `client/` |
| Users | `main`'s model (PR #3): `people` is auth only, and `households.members[]` owns role, `admin`, `relation` and `shift`. Unique `user_id`, `email` and `members.user_id`. |
| Login | Email + password, checked with `bcryptjs`. Emails are lowercased. Errors are generic ("Email or password is incorrect."). |
| Token | HS256 JWT signed with the shared `AUTH_SECRET`. Payload `{user_id, name, role, person_id}`, the same as `client/lib/auth.ts`. Expires in 7 days, the same as the client cookie. |
| Web client | The login server action calls `POST /auth/login` and stores the returned token in `keepsake_session` as it does today. `requireSession` keeps verifying locally. Next calls our APIs server to server with `Authorization: Bearer`, so the browser needs no CORS. |
| Revocation | Every API request re-reads membership from `households`. Removing a member cuts access at once. `admin` comes from the DB, not the token. |
| Agent | Runs as Margaret (role `person`) through her web login. The web client's `/api/talk/*` routes use the `keepsake_session` cookie and forward it as Bearer to backend services. ElevenLabs webhook tools can use `secret__keepsake_token` later if they call the API directly. |
| User creation | `POST /users` is for family admins only. `person_id` is forced to the admin's own household. Roles allowed: `family`, `caregiver`. |
| Care team | `GET /care-team` returns the caller's household only: `{user_id, name, role, relation, shift}`, with no email or credentials. Any role can call it. |
| Person profile | `timezone` on the person's doc (Margaret and Harold: `America/Toronto`) |
| Caregiver shift | Display label only |
| Client changes | Not in this PR. The README ships a typed contract and a ready-to-paste `client/lib/userService.ts` for the web owner. |
| Public URL | Local with a tunnel during the build, then deploy once before 3:30 as a backup |

## Data model

This plan first moved roles onto `people`. Emily's PR #3 merged first and chose the opposite: `people` is auth only and roles live in `households.members`, with `schema_version` on every doc. The web client uses that model too, so the user service adopted it and changes nothing in `db/`. `households.timezone` is optional and read when present.

## Endpoints

| Endpoint | Auth | Request → response |
|---|---|---|
| `GET /health` | none | → `{ok: true, mongo: "up"}` |
| `POST /auth/login` | none | `{email, password}` → `{token, user: {user_id, name, role, person_id}}`. 401 with a generic message on failure. |
| `GET /auth/me` | Bearer | → `{user_id, name, role, admin, person: {person_id, name, timezone}}` |
| `GET /care-team` | Bearer | → `[{user_id, name, role, relation?, shift?}]` for the caller's `person_id` |
| `POST /users` | Bearer, family + admin | `{name, email, password, role, relation?, shift?}` → the created user (no hash). 409 on a duplicate email. `user_id` is a slug from the name plus a suffix if needed. |

Errors use one shape: `{error: {code, message}}`.

## Layout

```
backend/
  src/
    config.ts   zod-parsed env: MONGODB_URI, MONGODB_DB, AUTH_SECRET, TOKEN_TTL, PORT, HOST
    db.ts       people / households types and collections
    auth.ts     sign session (same as client), authenticate (verify + re-read household membership), requireFamilyAdmin
    routes.ts   /health, /auth/login, /auth/me, /care-team, POST /users
    errors.ts   HttpError + { error: { code, message } } handler
    app.ts      buildApp({ db, config }); tests inject against this
    server.ts   connect + listen
  test/         auth.test.ts, users.test.ts (HTTP-level, mongodb-memory-server)
```

## Build order

1. DB prerequisite PR on `main`: web's `db/` without `kind`, plus `timezone`.
2. Scaffold `backend/`: config, Mongo connection, `/health`.
3. Tokens and hooks, with tests including "the token verifies with the client's `jose` code".
4. `/auth/login` and `/auth/me`.
5. `/care-team` and `POST /users`, with leakage and admin tests.
6. README contract for the web owner and the agent owner.

## Notes

- The Voyage key and Atlas password are in plain text in the planning Google doc. Rotate them after the hackathon. `.env` is never committed.
- Login has no rate limiting. That's fine for a demo, and the note is kept here.
- `client/lib/vectorstore.ts` queries Atlas from Next. The memory service plan should move that behind the memory service.
