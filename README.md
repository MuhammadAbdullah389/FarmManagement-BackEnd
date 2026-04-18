# Farm Management Backend API

This backend is now API-only. It serves JSON responses for the frontend and uses cookie-based JWT authentication.

## Overview

- Total documented API endpoint groups: 13
- Total route bindings in the current server, including legacy aliases: 18
- Public endpoints: 3
- Auth-protected endpoints: 6
- Admin-protected endpoints: 4
- Response style: JSON only
- Auth style: cookie-based JWT via `tId`
- Frontend integration style: SPA / API consumer

### Quick Snapshot

- Backend role: API server for the React frontend
- Data scope: daily records and monthly reports stored in MongoDB
- Main use cases: login, record CRUD, monthly reporting, session check
- Legacy SSR views and static assets have been removed

## Tech Stack

- Node.js
- Express.js
- MongoDB
- Mongoose
- JSON Web Token (`jsonwebtoken`)
- `cookie-parser`
- `dotenv`

## Base URL

- Local: `http://localhost:3000`
- Production: your deployed Render URL

## Important Rules

- All authenticated requests must include credentials.
- Frontend fetch example: `credentials: "include"`
- Axios example: `withCredentials: true`
- Auth cookie name: `tId`
- Cookie is `httpOnly`
- CORS is configured through `FRONTEND_ORIGIN`
- Do not include a trailing slash in `FRONTEND_ORIGIN`

## Common Response Format

### Success

```json
{
  "success": true,
  "message": "string",
  "data": {}
}
```

### Error

```json
{
  "success": false,
  "message": "string",
  "details": null
}
```

## Auth / Role Rules

- Public: health and login/logout
- Auth required: user session endpoints, records list, record detail, report list, monthly report
- Admin required: create/update/check/resolve record endpoints

## Data Formats

### User Object

```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "role": "user | admin"
}
```

### Money Item Object

```json
{
  "description": "string",
  "amount": 0
}
```

### Daily Record Object

```json
{
  "date": "dd/mm/yyyy",
  "morningMilkQuantity": 0,
  "eveningMilkQuantity": 0,
  "milkPrice": 0,
  "expenses": [],
  "revenues": [],
  "totalRevenue": 0,
  "totalExpenditure": 0,
  "Balance": 0
}
```

### Monthly Report Object

```json
{
  "month": "MM-YYYY",
  "openingBalance": 0,
  "netBalance": 0,
  "closingBalance": 0,
  "startDate": "dd/mm/yyyy",
  "endDate": "dd/mm/yyyy"
}
```

## API Endpoints

### 1) Health

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Check if server is running |

**Response data**

```json
{
  "up": true,
  "date": "dd/mm/yyyy"
}
```

---

### 2) Login

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | Public | Login user and set auth cookie |

**Request body**

```json
{
  "email": "admin@example.com",
  "password": "password123"
}
```

**Response data**

```json
{
  "user": {
    "id": "string",
    "name": "string",
    "email": "string",
    "role": "admin"
  }
}
```

**Notes**
- Sets cookie `tId` on success.
- Use credentials in the frontend request.

---

### 3) Current Logged-In User

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | Required | Return current authenticated user |

**Response data**

```json
{
  "user": {
    "id": "string",
    "name": "string",
    "email": "string",
    "role": "admin"
  }
}
```

---

### 4) Logout

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/logout` | Public | Clear auth cookie |

**Response data**

```json
null
```

---

### 5) Dashboard Payload

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | Required | Dashboard data |
| `GET` | `/home` | Required | Dashboard data |

**Response data**

```json
{
  "user": {
    "id": "string",
    "name": "string",
    "email": "string",
    "role": "admin"
  },
  "today": "dd/mm/yyyy",
  "todayEntryExists": true
}
```

---

### 6) List Records By Month

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/records` | Required | List records for a month |

**Query params**

- `month` optional, number `1` to `12`
- `year` optional, full year like `2026`

**Response data**

```json
{
  "entries": [],
  "currentMonth": 4,
  "currentYear": 2026,
  "monthDisplay": "April",
  "prevMonth": 3,
  "prevYear": 2026,
  "nextMonth": 5,
  "nextYear": 2026,
  "canGoToNextMonth": true,
  "user": {
    "name": "Admin",
    "role": "admin"
  },
  "date": "dd/mm/yyyy"
}
```

---

### 7) Get Single Record

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/records/:date` | Required | Fetch one record by date |

**Path param**

- `date` must be `dd/mm/yyyy`
- URL-encode it if needed

**Response data**

```json
{
  "entry": {},
  "date": "dd/mm/yyyy",
  "postingDate": "encoded-date",
  "user": {
    "name": "Admin",
    "role": "admin"
  }
}
```

---

### 8) Create Record

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/records` | Admin | Create a new daily record |

**Request body**

```json
{
  "recordDate": "dd/mm/yyyy",
  "morningMilk": 10,
  "eveningMilk": 12,
  "expenses": {
    "0": {
      "description": "Feed",
      "amount": 500
    }
  },
  "revenues": {
    "0": {
      "description": "Other sale",
      "amount": 300
    }
  }
}
```

**Notes**
- `recordDate` is optional. If omitted, current date is used.
- `expenses` and `revenues` are object maps, not arrays.
- Each item must include `description` and `amount`.

**Response data**

```json
{
  "date": "dd/mm/yyyy",
  "submission": {}
}
```

---

### 9) Update Record

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `PUT` | `/api/records/:date` | Admin | Update an existing record |

**Path param**

- `date` must be `dd/mm/yyyy`
- URL-encode it if needed

**Request body**

```json
{
  "morningMilk": 10,
  "eveningMilk": 12,
  "expenses": {
    "0": {
      "description": "Feed",
      "amount": 500
    }
  },
  "revenues": {
    "0": {
      "description": "Other sale",
      "amount": 300
    }
  }
}
```

**Response data**

```json
{
  "date": "dd/mm/yyyy",
  "updatedEntry": {}
}
```

---

### 10) Check New Record Date

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/records/check-new-date` | Admin | Validate a current-month date before creating a new record |

**Request body**

```json
{
  "date": "2026-04-05"
}
```

**Response data**

```json
{
  "minDate": "2026-04-01",
  "maxDate": "2026-04-30",
  "selectedDateInput": "2026-04-05",
  "selectedDate": "05/04/2026"
}
```

**Errors**
- `400` if date is not in the current month
- `409` if record already exists

---

### 11) Resolve Date For Update

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/records/resolve-date` | Admin | Convert input date and verify record exists |

**Request body**

```json
{
  "date": "2026-04-05"
}
```

**Response data**

```json
{
  "requestedDate": "2026-04-05",
  "formattedDate": "05/04/2026",
  "encodedDate": "05%2F04%2F2026"
}
```

---

### 12) List Report Months

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/reports/months` | Required | List all available monthly reports |

**Response data**

```json
{
  "months": ["April 2026"],
  "rawMonths": [],
  "user": {
    "name": "Admin",
    "role": "admin"
  },
  "date": "dd/mm/yyyy"
}
```

---

### 13) Monthly Report

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/reports/:month` | Required | Get records and summary for one month |

**Path param formats accepted**
- `MM-YYYY` like `04-2026`
- `Month YYYY` like `April 2026`

**Response data**

```json
{
  "month": "04",
  "year": "2026",
  "records": [],
  "monthlyRep": {},
  "user": {
    "name": "Admin",
    "role": "admin"
  },
  "date": "dd/mm/yyyy"
}
```

---

## Error Status Codes

| Status | Meaning |
| --- | --- |
| `400` | Invalid input or date format |
| `401` | Not authenticated |
| `403` | Authenticated but not admin |
| `404` | Resource not found |
| `409` | Duplicate/conflict |
| `500` | Server error |

## Frontend Integration Example

### Fetch

```js
const res = await fetch("https://your-backend-url/api/auth/me", {
  method: "GET",
  credentials: "include",
});
```

### Axios

```js
const res = await axios.get("https://your-backend-url/api/auth/me", {
  withCredentials: true,
});
```

## Notes For Frontend Dev

- Always send credentials for authenticated requests.
- Always use the `/api/*` routes.
- Do not depend on legacy SSR routes.
- Dates are stored as `dd/mm/yyyy` in daily records.
- Month routes use `MM-YYYY` or `Month YYYY`.
