---
phase: 02-code-review-yclients-integration
reviewed: 2026-04-12T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - /root/loyalpro/server.js
  - /root/loyalpro/frontend/index.html
findings:
  critical: 2
  warning: 2
  info: 3
  total: 7
status: issues_found
---

# Code Review: YClients Integration Bug Analysis

**Issue:** Company ID (yclients_company_id) not saved during Yclients connection despite tokens being saved.

**Diagnosis:** Frontend validates and collects Company ID, but does not send it to server endpoint. Backend endpoint accepts tokens only, ignoring Company ID entirely. This prevents synchronization which requires Company ID.

## Critical Issues

### CR-01: Frontend does not send Company ID to server endpoint

**File:** `/root/loyalpro/frontend/index.html:1228-1233`

**Issue:** The `connectYC()` function collects `yclients_company_id` from input field `st-yid` (line 1218, validated at line 1220), but DOES NOT include it in the API request body sent to server.

The request sends only:
```javascript
const res = await api('POST','/api/salon/yclients-auth',{
  partnerToken: pt,
  login: login,
  password: pass,
  chainId: document.getElementById('st-chain-id')?.value || null,
});
```

Company ID (`yid`) is validated but never sent to server.

**Fix:** Add `yclients_company_id` to the request body:
```javascript
const res = await api('POST','/api/salon/yclients-auth',{
  partnerToken: pt,
  login: login,
  password: pass,
  yclients_company_id: yid,
  chainId: document.getElementById('st-chain-id')?.value || null,
});
```

---

### CR-02: Backend endpoint ignores Company ID parameter

**File:** `/root/loyalpro/server.js:588-601`

**Issue:** The endpoint `/api/salon/yclients-auth` only accepts and stores `partnerToken`, `login`, and `password`, but does not accept `yclients_company_id` in request body. The SQL UPDATE statement (line 593) updates only partner_token and user_token, ignoring Company ID completely:

```javascript
const { partnerToken, login, password } = req.body;  // ← missing yclients_company_id
const d = await ycAuth(partnerToken, login, password);
await db.query(
  'UPDATE salons SET yclients_partner_token=$1,yclients_user_token=$2,updated_at=NOW() WHERE id=$3',
  [partnerToken, d.user_token, req.user.salonId]
);
```

This is the root cause: even if frontend sends Company ID, server will not save it.

**Fix:** Accept and store Company ID:
```javascript
app.post('/api/salon/yclients-auth', auth, async (req, res) => {
  try {
    const { partnerToken, login, password, yclients_company_id } = req.body;
    
    // Validate Company ID is provided
    if (!yclients_company_id) {
      return res.status(400).json({ error: 'Company ID (yclients_company_id) is required' });
    }
    
    const d = await ycAuth(partnerToken, login, password);
    await db.query(
      'UPDATE salons SET yclients_partner_token=$1,yclients_user_token=$2,yclients_company_id=$3,updated_at=NOW() WHERE id=$4',
      [partnerToken, d.user_token, yclients_company_id, req.user.salonId]
    );
    res.json({ ok: true, userToken: d.user_token });
  } catch (e) {
    console.error('[YC Auth error]', e.message, e.response?.data);
    res.status(400).json({ error: e.message });
  }
});
```

---

## Warnings

### WR-01: Missing endpoint `/api/yclients/card-types`

**File:** `/root/loyalpro/frontend/index.html:950-969` and `/root/loyalpro/server.js`

**Issue:** Frontend function `loadCardTypes()` (line 950-969) calls endpoint:
```javascript
const types = await api('GET', '/api/yclients/card-types');
```

But this endpoint **does not exist in server.js**. This causes a runtime error when user clicks "Load card types" button after successful connection. The function will fail silently or show generic error.

**Evidence:** Search of server.js shows only 3 yclients endpoints:
- `POST /api/webhook/yclients/:companyId` (line 379)
- `POST /api/salon/yclients-auth` (line 588) 
- `GET /api/yclients/services` (line 835)

No `/api/yclients/card-types` endpoint exists.

**Fix:** Implement missing endpoint in server.js:
```javascript
app.get('/api/yclients/card-types', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) {
      return res.status(400).json({ error: 'YClients not configured' });
    }
    // Fetch card types from YClients API
    const cardTypes = await ycGet(salon, `/company/${salon.yclients_company_id}/card_types`);
    res.json(cardTypes);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
```

---

### WR-02: Unused `chainId` parameter sent from frontend, never used by backend

**File:** `/root/loyalpro/frontend/index.html:1232` and `/root/loyalpro/server.js:590`

**Issue:** Frontend sends `chainId` parameter in connectYC() request (line 1232), but backend endpoint completely ignores it. Additionally, `chainId` is never used anywhere in server.js codebase.

This suggests either:
1. Feature incomplete (chainId should be stored but isn't)
2. Code left over from previous implementation

This creates confusion and indicates incomplete functionality.

**Fix:** Either:
- **Option A:** Remove unused parameter from frontend if not needed for Yclients integration
- **Option B:** If chainId (salon_group_id) is needed, add it to backend endpoint and store it in salons table

Recommend Option B if loyalty card selection depends on salon group. Code structure suggests chainId may be intentional but unfinished.

---

## Info

### IN-01: Validation in frontend executed, but never reaches server

**File:** `/root/loyalpro/frontend/index.html:1220-1223`

**Issue:** Frontend validates that all 4 fields (ID, Partner Token, Login, Password) are provided before submitting. However, backend endpoint (line 588-601) does NOT validate any of these parameters. If validation logic needs to change, it's duplicated across frontend and backend.

**Suggestion:** Add validation to backend endpoint to ensure it doesn't rely solely on frontend validation:
```javascript
if (!partnerToken || !login || !password || !yclients_company_id) {
  return res.status(400).json({ error: 'Missing required fields' });
}
```

---

### IN-02: Company ID is shown in two places but only one is functional

**File:** `/root/loyalpro/frontend/index.html:1162, 1165, 1204, 1218`

**Issue:** Company ID appears in:
1. YClients Connection section (input `st-yid`) — used by connectYC()
2. Webhook URL display (line 1165) — constructed from `salon.yclients_company_id`
3. saveSalon() function (line 1204) — CAN update Company ID via PUT /api/salon

This creates confusion about the proper way to set Company ID. User sees three different ways to interact with it.

**Suggestion:** Clarify UX by:
- Making connectYC() the primary way to set Company ID (after this bug is fixed)
- Either hiding the direct input field OR making it clear it's for manual override only
- Document that Company ID can be updated either via "Connect YClients" button or manual entry + Save

---

### IN-03: Sync endpoint validates Company ID exists, but won't have it if auth bug not fixed

**File:** `/root/loyalpro/server.js:807-809`

**Issue:** The sync endpoint correctly checks that Company ID exists before running sync:
```javascript
if (!salon.yclients_company_id || !salon.yclients_user_token) {
  return res.status(400).json({ error: 'YClients not configured...' });
}
```

However, because of CR-01 and CR-02, users following normal connection flow will reach this check with `yclients_company_id = NULL`, causing sync to fail immediately with confusing error message.

This is the symptom users are experiencing: sync "requires Company ID and falls".

**Suggestion:** After fixing CR-01 and CR-02, the error handling will work as intended. No additional fix needed, but document that both tokens AND Company ID must be set during connection.

---

## Summary

**Root Cause Chain:**
1. Frontend validates Company ID but doesn't send it → request missing data
2. Backend endpoint doesn't accept Company ID parameter → won't save even if sent
3. Sync endpoint requires Company ID → fails with confusing error

**Impact:** YClients connection appears to succeed (tokens saved) but synchronization immediately fails because Company ID is NULL, making the entire integration non-functional.

**Fix Priority:**
1. **CRITICAL:** Fix backend endpoint (CR-02) to accept and store `yclients_company_id`
2. **CRITICAL:** Fix frontend to send `yclients_company_id` (CR-01)
3. **HIGH:** Implement missing card types endpoint (WR-01)
4. **MEDIUM:** Clean up unused chainId parameter or complete its implementation (WR-02)
5. **LOW:** Add backend validation and improve UX documentation (IN-01 to IN-03)

**Testing Recommendations:**
- After fixes, verify Company ID is saved in database when connection succeeds
- Verify sync endpoint can proceed past Company ID validation
- Test card types loading after connection
- Verify webhook URL correctly uses saved Company ID

---

_Reviewed: 2026-04-12_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
