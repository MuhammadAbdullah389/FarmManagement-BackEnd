# Farm Management Backend API

API-only backend for Advanced FMS. It serves JSON responses, uses cookie-based JWT auth, supports daily farm records, monthly reports, and HR employee/transaction workflows.

## Highlights

- Cookie auth with `tId` (httpOnly)
- Role-based access (`user`, `admin`, `superadmin`)
- Daily record create/update with month-aware validation
- Monthly report summaries (`opening`, `net`, `closing`)
- HR module: employees, transactions, settlement preview/execute, mark-left
- HR transaction sync into daily records as readonly line items
- HR transaction delete sync for unsettled entries
- Monthly consistency logic with incremental rebuild from dirty month
- Tenant-aware auth and data scoping through `tenantId` / `tenantCode`
- Tenant subscription state stored with `isActive` and `inactiveUntil`
- Superadmin farm lifecycle APIs for list, create, toggle, delete, and overview
- Admin user management APIs for listing, creating, and deleting tenant users

## Tech Stack

- Node.js
- Express.js
- MongoDB + Mongoose
- jsonwebtoken
- cookie-parser
- dotenv

## Base URL

- Local: `http://localhost:3000`
- Production: your deployed backend URL

## Environment Variables

- `PORT` optional, default `3000`
- `DB_URL` required, MongoDB connection string
- `SECRET_KEY` required, JWT signing key
- `FRONTEND_ORIGIN` required, comma-separated allowed origins without trailing slash
- `MILKPRICE` optional, default milk price fallback

## Auth And CORS Rules

- Auth cookie name: `tId`
- Frontend must send credentials on authenticated calls
- Fetch: `credentials: "include"`
- Axios: `withCredentials: true`
- CORS allow-list is derived from `FRONTEND_ORIGIN`
- Superadmin and admin checks are enforced by route middleware in `server.js`

## Common Response Envelope

Success:

```json
{
  "success": true,
  "message": "string",
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "message": "string",
  "details": null
}
```

## Data Model Notes

### Daily Record

Daily line items now support source metadata.

```json
{
  "description": "string",
  "amount": 0,
  "readonly": false,
  "source": "manual | hr",
  "sourceRefType": "hr_transaction | null",
  "sourceRefId": "string | null"
}
```

Readonly HR-synced line items are preserved by backend during daily record updates.

### HR Transaction

```json
{
  "_id": "string",
  "type": "advance | payback",
  "amount": 0,
  "note": "string",
  "transactionDate": "dd/mm/yyyy",
  "settledAt": "date | null"
}
```

Only unsettled HR transactions can be edited.

Unsettled transactions can also be deleted. Delete removes the transaction from the employee, removes its synced readonly line from the daily record, and marks the affected month dirty for rebuild.

### Tenant Subscription

- Tenant status is stored on the tenant document with `isActive` and `inactiveUntil`
- Superadmin activates a farm with a calendar date/time expiry
- Farm admins can still log in when inactive; the frontend redirects them to a locked subscription-expired page
- Deleting or toggling a farm happens through the `/api/superadmin/farms` endpoints

### Admin Users

- Tenant admins can list users for their farm
- Tenant admins can create and delete users for their farm
- Superadmin accounts are filtered out of the tenant user list and cannot be deleted from tenant settings

## API Endpoints

### Health And Auth

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/health | Public | Service health |
| POST | /api/auth/login | Public | Login and set cookie |
| GET | /api/auth/me | Auth | Current user |
| POST | /api/auth/logout | Public | Logout |

### Admin Users

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/admin/users | Admin | List tenant users |
| POST | /api/admin/users | Admin | Create tenant user |
| DELETE | /api/admin/users/:id | Admin | Delete tenant user |

### Dashboard

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | / | Auth | Dashboard payload |
| GET | /home | Auth | Dashboard payload |

### Daily Records

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/records | Auth | List records by month/year |
| GET | /api/records/:date | Auth | Single record detail |
| POST | /api/records | Admin | Create record |
| PUT | /api/records/:date | Admin | Update record |
| POST | /api/records/check-new-date | Admin | Validate create date |
| POST | /api/records/resolve-date | Admin | Resolve date for update |

Request body for create/update still uses map-style `expenses` and `revenues` objects.

### Monthly Reports

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/reports/months | Auth | Available months |
| GET | /api/reports/:month | Auth | Monthly report by `MM-YYYY` or `Month YYYY` |

### HR Module

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/hr/overview | Admin | HR dashboard summary |
| POST | /api/hr/employees | Admin | Add employee |
| GET | /api/hr/employees/:id | Admin | Employee detail |
| POST | /api/hr/employees/:id/transactions | Admin | Add advance/payback |
| PUT | /api/hr/employees/:id/transactions/:transactionId | Admin | Edit unsettled transaction |
| DELETE | /api/hr/employees/:id/transactions/:transactionId | Admin | Delete unsettled transaction |
| POST | /api/hr/employees/:id/increase-pay | Admin | Increase salary |
| POST | /api/hr/employees/:id/settlement-preview | Admin | Settlement preview |
| POST | /api/hr/employees/:id/settle | Admin | Execute settlement |
| POST | /api/hr/employees/:id/mark-left | Admin | Mark employee left |

### Superadmin Farms

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | /api/superadmin/farms | Superadmin | List farm tenants |
| POST | /api/superadmin/farms | Superadmin | Create a farm tenant and admin |
| PATCH | /api/superadmin/farms/:id/status | Superadmin | Toggle farm active state |
| DELETE | /api/superadmin/farms/:id | Superadmin | Delete a farm tenant |
| GET | /api/superadmin/report | Superadmin | Platform summary report |
| GET | /api/superadmin/farms/:code/overview | Superadmin | View a farm overview |

## HR To Daily Record Sync Behavior

Implemented behavior:

1. HR advance creates/updates a readonly expense line in daily record.
2. HR payback creates/updates a readonly revenue line in daily record.
3. Editing an unsettled HR transaction updates its linked readonly daily line, including date/type/amount/note changes.
4. Deleting an unsettled HR transaction removes its linked readonly daily line from the daily record.
5. Daily record edit endpoints cannot overwrite HR readonly lines.

Generated description pattern:

- `HR Advance - Employee Name (optional note)`
- `HR Payback - Employee Name (optional note)`

## Monthly Consistency Logic

Monthly report consistency is maintained with incremental rebuild:

1. Writes mark a dirty start month.
2. Rebuild runs from earliest dirty month forward.
3. Opening/closing balances are recomputed in sequence.
4. Report reads ensure data is up to date when dirty.

This prevents drift between month closing and next month opening.

## Status Codes

| Status | Meaning |
| --- | --- |
| 400 | Validation or date window error |
| 401 | Authentication required |
| 403 | Admin required |
| 404 | Resource not found |
| 409 | Duplicate/conflict |
| 500 | Server error |

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Set environment variables in `.env`.

3. Start server:

```bash
node server.js
```

## Frontend Integration Notes

- Always call `/api/*` routes.
- Always include credentials on authenticated requests.
- Daily dates are stored as `dd/mm/yyyy`.
- Report month supports `MM-YYYY` and `Month YYYY`.
- Daily record responses may include readonly HR line items with metadata.
- Inactive tenants are not hard-blocked at login; the frontend handles the expired-subscription gate.
