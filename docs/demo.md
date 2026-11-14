# Keepsake write-path demo

The steps below were first proven in the QA run on 14 Nov 2026 (icaro, then on `feat/write-validate`, database `keepsake_test`). They still apply on `main`. The "Not for the demo" notes at the end reflect the current code, including the 0.55 time-stripped cutoff and the year check on relative dates.

## Setup

- Next client on `http://localhost:3000`, user service on `127.0.0.1:4000`, both with `MONGODB_DB=keepsake_test`.
- Logins: `anna@keepsake.test` (family, admin), `ravi@keepsake.test` (caregiver), `margaret@keepsake.test` (person). Demo password as in `backend/README.md`.
- In the UI, sign in at `/login`. For API steps, log in once per user and keep the cookie:

```sh
login() {  # usage: login anna
  curl -s 127.0.0.1:4000/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$1@keepsake.test\",\"password\":\"$DEMO_PASSWORD\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])' > /tmp/demo-$1.tok
}
q() {  # usage: q anna POST /api/memories '{"text":"..."}'
  curl -s -X "$2" "http://localhost:3000$3" \
    -H "cookie: keepsake_session=$(cat /tmp/demo-$1.tok)" \
    ${4:+-H 'content-type: application/json' -d "$4"} -w '\n[HTTP %{http_code}]\n'
}
```

- Label every demo memory `[DEMO]`.

## Pacing and budget

- **Gemini budget: 6 calls** (steps 2, 3, 4, 7, 9a, 9b). The free tier is about 20 calls a day. Every other step costs 0 Gemini calls.
- **Space Gemini/Voyage writes about 70 seconds apart.** Voyage writes retry on 429, but the free tier is still about 3 requests a minute, and a 503 still burns the Gemini validate call. Steps marked ⏱ call Voyage; wait about 70 s before each one.
- Read-only steps (review queue, lists) and the 400/403/404 checks can run at any time.

## Flow

### 1. Signed out gets 401 (0 Gemini)

| User | Action | Expected |
|---|---|---|
| none | `curl -s localhost:3000/api/reviews` (no cookie) | 401 `{"error":{"code":"unauthorized","message":"Sign in required"}}` |

The same 401 comes back for GET/POST `/api/memories`, corrections, review and DELETE, and with a bad `keepsake_session` cookie.

### 2. Anna adds a memory with a relative date (1 Gemini) ⏱

| User | Action | Example input | Expected |
|---|---|---|---|
| anna | Dashboard add form, or `q anna POST /api/memories '<body>'` | `{"text":"[DEMO] Leo is coming tomorrow at 6pm","scope":"family"}` | 201, `status: verified`, `from: Anna (family)`, `event_start: 2026-11-15T23:00:00Z` (Sun Nov 15, 6 pm ET) |

Show the stored text with `q anna GET /api/memories`: it reads `[DEMO] Leo is coming on Sun Nov 15 at 6pm`, so "tomorrow" was rewritten to the real date. Note the new `memory_id` for step 9.

### 3. Anna adds a two-fact note, no conflict (1 Gemini) ⏱

| User | Action | Example input | Expected |
|---|---|---|---|
| anna | `q anna POST /api/memories '<body>'` | `{"text":"[DEMO] Joan next door has a grey cat named Pepper. [DEMO] The hallway light switch is behind the coat rack.","scope":"family"}` | 201 `{"batch":true,"saved":true,"facts":[...]}`: two facts, each saved `verified` |

### 4. A note that conflicts: batch needs confirmation (1 Gemini) ⏱

One fact repeats the cat memory from step 3, so the system proposes a supersede for it.

| User | Action | Example input | Expected |
|---|---|---|---|
| anna | `q anna POST /api/memories '<body>'` | `{"text":"[DEMO] Joan next door has a grey cat named Pepper. [DEMO] The spare umbrella is in the hall closet.","scope":"family"}` | 200 `{"batch":true,"saved":false,"facts_token":"...","facts":[...]}`. Fact 1: `needs_confirmation: true`, `old` = the step 3 cat memory ("Are you sure? This will supersede …"). Fact 2: `{"saved":false,"needs_confirmation":false}`. Nothing is saved yet. |

Save this response; steps 5 and 6 resend its `facts` and `facts_token`.

### 5. Tampered resends are rejected (0 Gemini)

Resend body base: `{"confirm":true,"facts":[<facts from step 4, fact 1 with "confirm_supersedes":"<old memory_id>">],"facts_token":"<token>","scope":"family"}`.

| User | Change to the resend | Expected |
|---|---|---|
| anna | `facts[]` with no `confirm` and no token (first submit) | 400 `facts is only accepted on a confirm resend (confirm: true, no text)` |
| anna | One fact's `event_start` edited | 400 `facts don't match the ones we returned; add the note again` |
| anna | One fact's `text` edited | 400, same message |
| anna | `facts_token` removed | 400, same message |
| anna | `text` sent along with `facts` | 400 `facts is only accepted on a confirm resend …` |

Nothing is saved by any of these.

### 6. Wrong confirm, then the real confirm (0 Gemini) ⏱

| User | Action | Expected |
|---|---|---|
| anna | Resend unchanged, but fact 1 `confirm_supersedes` = some other verified memory id | 409 with a fresh `saved:false` batch (same "Are you sure?" payload). Nothing saved. |
| anna | ⏱ Resend unchanged with the correct `confirm_supersedes` | 201 `saved:true`. Fact 1: `verified`, `supersedes` = old id, `audit_action: approve`. Fact 2: `verified`, `audit_action: write`. The old cat memory is now `superseded` (`q anna GET '/api/memories?status=superseded'`). |
| anna | ⏱ Send the exact same confirm again | 409, nothing saved (both facts now duplicate live memories). |

### 7. Ravi adds a note; spoofed fields are ignored (1 Gemini) ⏱

| User | Action | Example input | Expected |
|---|---|---|---|
| ravi | Caregiver add form, or `q ravi POST /api/memories '<body>'` | `{"text":"[DEMO] Joan next door has a grey cat named Pepper.","scope":"family","status":"verified","source":{"user_id":"anna","name":"Anna","role":"family"},"review":{"state":"approved"}}` | 201, `status: unverified`, `scope: caregiver`, `from: Ravi (caregiver)`, `needs_family_review: true`. `proposed_supersedes` and `message` are `null`: the memory it would replace is family scope, which Ravi can't read. |

### 8. Anna reviews Ravi's note (0 Gemini)

| User | Action | Expected |
|---|---|---|
| anna | Dashboard review queue, or `q anna GET /api/reviews` | Ravi's note is listed: "from: Ravi (caregiver)", `flagged: true`, message "This will supersede [DEMO] Joan next door has a grey cat named Pepper." with `proposed_old` (text, author Anna, date) |
| anna | Deny: `q anna POST /api/memories/<ravi id>/review '{"decision":"deny"}'` | 200, `new_status: retracted`, `review_state: denied`, `old_status: verified` (the old memory is untouched), `audit_action: deny` |
| anna | Confirm the same item: `'{"decision":"confirm"}'` | 409 `This review has already been decided` |

### 9. Anna corrects a memory (2 Gemini) ⏱

| Step | User | Action | Example input | Expected |
|---|---|---|---|---|
| 9a | anna | `q anna POST /api/memories/<step 2 id>/corrections '<body>'` | `{"text":"[DEMO] Leo is coming tomorrow at 8pm","scope":"caregiver"}` | 200 `needs_confirmation: true`, `old` = "[DEMO] Leo is coming on Sun Nov 15 at 6pm". Nothing saved. |
| 9b | anna | Same body plus `"confirm":true,"confirm_supersedes":"<step 2 id>"` | | 201, `status: verified`, `scope: family` (inherited from the old memory; the sent `caregiver` is ignored), `supersedes` = step 2 id, `audit_action: approve`, `event_start: 2026-11-16T01:00:00Z` (Sun Nov 15, 8 pm ET). The step 2 memory is now `superseded`. |

### 10. Role and input checks (0 Gemini)

All are rejected before any Gemini or Voyage call. Use any existing ids.

| User | Request | Expected |
|---|---|---|
| ravi | POST `/api/memories/<id>/corrections` | 403 `Only family can correct a memory; caregivers add a note for review instead` |
| ravi | POST `/api/memories/<id>/review` confirm or deny | 403 `Only a family member can confirm or deny a review` |
| ravi | GET `/api/reviews` | 403 `Only family can see the review queue` |
| ravi | DELETE `/api/memories/<id>` | 403 `Only family can forget a memory` |
| ravi | GET `/api/memories` | 200, only Ravi's own caregiver-scope notes |
| margaret | POST `/api/memories` | 403 `Only family and caregivers can add memories` |
| margaret | GET `/api/memories` or `/api/reviews` | 403 |
| anna | POST `/api/memories` `{"text":"   "}` | 400 `text is required` |
| anna | POST `/api/memories` with 501+ characters | 400 `text is longer than 500 characters` |
| anna | POST `/api/memories` `{"text":"[DEMO] x","scope":"private"}` | 400 `scope must be family or caregiver` |
| anna | POST review `{"decision":"maybe"}` | 400 `decision must be "confirm" or "deny"` |
| anna | POST review on an unknown or malformed id | 404 |
| anna | POST corrections on an unknown id, or on an unverified memory | 404 `Memory not found` |
| anna | POST corrections `{"text":"  "}` | 400 `text is required` |

## Not for the demo

- **Multi-fact add right after another write.** Voyage's free tier is about 3 requests a minute. Writes now retry 429s, but back-to-back adds can still return 503 "The memory check is unavailable right now", and each failed write still uses a Gemini call (validate runs before Voyage). Wait about 70 s between writes that hit Voyage.
- **"Yesterday" dates are safer than they were, but still worth avoiding live.** Validate now moves a date that landed more than about six months away when the note gave no year, so the 2025-vs-2026 miss should not be stored. The rewrite in the stored text still comes from Gemini, so keep demo wording on explicit days when you can.
- **A Leo 7pm reschedule should now show "Are you sure?"** The plain rerank cutoff is still 0.8, and "Leo is now coming tomorrow at 7pm, not 6pm" scored 0.785 on that check alone. The time-stripped rerank (cutoff 0.55, on `main`) scored that pair at 0.818, so the confirm prompt should fire. Near-identical wording (steps 4, 7) still crosses the plain cutoff.
