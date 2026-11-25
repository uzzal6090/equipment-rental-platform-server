# Equipment Rental Platform — Server API

## Project Purpose

Backend API for the Equipment Rental Platform. Provides REST endpoints for authentication, equipment management, bookings, payments, favorites, and role-based dashboards. Built with Express 5, MongoDB, Better Auth, Stripe, and ImgBB.

## Technology Stack

| Category | Technology |
|----------|------------|
| Runtime | Node.js (ESM) |
| Framework | Express 5 |
| Database | MongoDB (native driver, transactions) |
| Auth | Better Auth + MongoDB adapter, JWT verification |
| Payments | Stripe (Checkout Sessions + Webhooks) |
| Images | ImgBB (base64 upload, URL storage) |
| Validation | Zod (via Better Auth), custom middleware |
| Deployment | Vercel (serverless) + local development |

**Verified dependencies from `package.json`:**
- `@better-auth/mongo-adapter`, `better-auth`
- `cors`, `dotenv`, `express`, `jose`, `mongodb`, `stripe`
- Dev: `nodemon`

## Installation & Development

```bash
# Install dependencies
npm install

# Copy environment template and fill in values
cp .env.example .env

# Start development server with auto-reload (port 5000)
npm run dev

# Start production server
npm run start

# Admin bootstrap scripts
npm run bootstrap:admin           # Create admin user
npm run bootstrap:admin:inspect   # Inspect admin user
npm run bootstrap:owner           # Create owner user
npm run bootstrap:owner:inspect   # Inspect owner user
```

**Verified scripts from `package.json`:**
- `dev` — `nodemon server.js` (port 5000, confirmed in `server.js:37`)
- `start` — `node server.js`
- `bootstrap:admin` — `node scripts/bootstrap-admin.js bootstrap`
- `bootstrap:admin:inspect` — `node scripts/bootstrap-admin.js inspect`
- `bootstrap:owner` — `node scripts/bootstrap-owner.js bootstrap`
- `bootstrap:owner:inspect` — `node scripts/bootstrap-owner.js inspect`

## Environment Variables

| Variable | Required | Description | Default / Notes |
|----------|----------|-------------|-----------------|
| `PORT` | No | Server port | `5000` |
| `NODE_ENV` | No | Environment mode | `development` |
| `MONGODB_URI` | **Yes** | MongoDB Atlas connection string | Validated in `src/config/env.js:3` |
| `DNS_SERVERS` | No | Custom DNS for MongoDB resolution | `8.8.8.8,8.8.4.4` |
| `DB_NAME` | No | Database name | `equipment_rental_db` (fallback in `src/config/db.js:8`) |
| `BETTER_AUTH_SECRET` | **Yes** | Better Auth encryption secret (32+ chars) | Validated in `src/config/env.js:6` |
| `BETTER_AUTH_URL` | **Yes** | Auth callback base URL (must be HTTP/HTTPS) | Validated in `src/config/env.js:5` |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID | Optional; enables Google sign-in |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret | Optional; paired with CLIENT_ID |
| `JWT_SECRET` | **Yes** | JWT signing secret | Validated in `src/config/env.js:4` |
| `JWT_EXPIRES_IN` | No | Access token TTL | `15m` |
| `STRIPE_SECRET_KEY` | **Yes** | Stripe secret key | Validated in `src/config/env.js:8` |
| `STRIPE_WEBHOOK_SECRET` | **Yes** | Stripe webhook signing secret | Validated in `src/config/env.js:9` |
| `IMGBB_API_KEY` | **Yes** | ImgBB API key for image uploads | Validated in `src/config/env.js:10` |
| `CLIENT_URL` | **Yes** | Frontend origin (CORS + redirect URLs) | Validated in `src/config/env.js:7` |

### Platform-Injected Variables

| Variable | Description |
|----------|-------------|
| `VERCEL=1` | Automatically injected by Vercel; do not set manually. Used in `server.js:245` to skip `app.listen()`. |

### Stripe Local Test Variables (Optional)

These are used only when `NODE_ENV=test` with a local Stripe mock server (e.g., Stripe CLI). **Not required for normal development or production.**

| Variable | Description |
|----------|-------------|
| `STRIPE_API_HOST` | Mock Stripe server host (e.g., `localhost`) |
| `STRIPE_API_PROTOCOL` | Protocol for mock server (`http` or `https`) |
| `STRIPE_API_PORT` | Mock Stripe server port (default `12111`) |

**Used in:** `src/modules/equipment/stripe.service.js:22-25`

> **Note:** Never commit actual secret values. Use `.env` (gitignored) for local development.

## API Overview

Base path: `/api`

### Health Check
- `GET /` — Returns `{ success: true, message: "Equipment Rental Platform API is running!" }`

### Authentication (`/api/auth/*`)
Handled by Better Auth. Key endpoints:
- `POST /api/auth/signup/email` — Email/password registration
- `POST /api/auth/signin/email` — Email/password login
- `POST /api/auth/signout` — Sign out
- `GET /api/auth/session` — Get current session
- `GET /api/auth/token` — Get JWT token (used by frontend)
- `GET /api/auth/callback/google` — Google OAuth callback

### Equipment
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/equipment` | No | Public | List equipment with search, filters, sort, pagination |
| `POST` | `/api/equipment` | Yes | Owner | Create new equipment |
| `GET` | `/api/equipment/owner/me` | Yes | Owner | List owner's equipment (all statuses) |
| `GET` | `/api/equipment/:id` | Yes | Any | Private equipment details |
| `PUT` | `/api/equipment/:id` | Yes | Owner | Update own equipment |
| `DELETE` | `/api/equipment/:id` | Yes | Owner | Delete own equipment |
| `POST` | `/api/equipment/image` | Yes | Owner | Upload equipment image (base64 → ImgBB) |

### Favorites
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `POST` | `/api/favorites` | Yes | Customer | Add equipment to favorites |
| `GET` | `/api/favorites` | Yes | Customer | List customer's favorites |
| `DELETE` | `/api/favorites/:id` | Yes | Customer | Remove favorite |

### Bookings & Checkout
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `POST` | `/api/bookings` | Yes | Customer | Create checkout intent → Stripe Checkout URL |
| `POST` | `/api/bookings/cancel/:intentId` | Yes | Customer | Cancel pending checkout intent |
| `GET` | `/api/bookings/checkout/:sessionId` | Yes | Customer | Get booking status after Stripe redirect |

### Customer Rentals
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/rentals` | Yes | Customer | List customer's rental history |

### Owner Rentals
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/owner/rentals` | Yes | Owner | List rentals for owner's equipment |

### Admin
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/admin/analytics` | Yes | Admin | Platform analytics (users, equipment, revenue) |
| `GET` | `/api/admin/users` | Yes | Admin | List all users with roles |
| `PATCH` | `/api/admin/users/:id/role` | Yes | Admin | Update user role |
| `GET` | `/api/admin/equipment` | Yes | Admin | List all equipment (all statuses) |
| `PATCH` | `/api/admin/equipment/:id/approve` | Yes | Admin | Approve equipment |
| `PATCH` | `/api/admin/equipment/:id/reject` | Yes | Admin | Reject equipment |
| `PUT` | `/api/admin/equipment/:id` | Yes | Admin | Update any equipment |
| `DELETE` | `/api/admin/equipment/:id` | Yes | Admin | Delete any equipment |
| `GET` | `/api/admin/rentals` | Yes | Admin | List all rentals across platform |

### Owner Analytics
| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/owner/analytics` | Yes | Owner | Owner-specific analytics (earnings, bookings) |

### Stripe Webhooks
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/webhooks/stripe` | No (signature verified) | Stripe webhook handler (idempotent) |
| `GET` | `/api/webhooks/stripe` | No | Health check for webhook endpoint |

### Profile
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/profile` | Yes | Get authenticated user's profile |
| `PUT` | `/api/profile` | Yes | Update profile (name, phone, address) |
| `POST` | `/api/profile/image` | Yes | Upload profile image (base64 → ImgBB) |

## Authentication & Authorization

### JWT Verification (`src/middleware/verifyToken.js`)
- Extracts Bearer token from `Authorization` header
- Verifies using JOSE with `JWT_SECRET`
- Validates `issuer` and `audience` against `BETTER_AUTH_URL`
- Attaches `req.user` (Better Auth user) and `req.profile` (MongoDB profile with `profileId`, `role`, `roleVersion`)

### Role Middleware
| Middleware | File | Required Role | Check |
|------------|------|---------------|-------|
| `verifyRenter` | `verifyRenter.js` | `customer` | `profile.role === "customer"` |
| `verifyOwner` | `verifyOwner.js` | `owner` | `profile.role === "owner"` |
| `verifyAdmin` | `verifyAdmin.js` | `admin` | `profile.role === "admin"` |

All role middlewares require `verifyToken` first. They also validate `roleVersion` matches the user's current version to prevent stale tokens after role changes.

### Better Auth Integration (`src/config/auth.js`)
- Uses MongoDB adapter for user/session storage
- Google OAuth enabled when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set
- JWT plugin issues tokens with `expirationTime` from `JWT_EXPIRES_IN`
- Cookie settings: `secure`/`sameSite: "none"` in production, `lax` in development
- Trusted origins: `[CLIENT_URL]`

## Database

### Connection (`src/config/db.js`)
- Single MongoDB client with connection pooling
- `DNS_SERVERS` configures custom DNS resolution for Atlas
- Transaction support verified at startup (required)
- Graceful shutdown closes connections on SIGTERM/SIGINT
- Database name from `DB_NAME` env or fallback `equipment_rental_db`

### Collections & Indexes (`src/config/indexes.js`, `src/config/schema.js`)
- `users` — Better Auth users (unique email)
- `sessions` — Better Auth sessions (TTL index on `expiresAt`)
- `accounts` — OAuth accounts
- `profiles` — Extended profile (unique `betterAuthUserId`, `role`, `roleVersion`)
- `equipment` — Equipment listings (text search index, compound indexes for queries)
- `bookings` — Confirmed bookings
- `checkoutIntents` — Pending Stripe checkout intents (inventory reservations)
- `favorites` — Customer favorites (unique user+equipment)
- `rentals` — Rental records
- `webhookEvents` — Stripe webhook idempotency (unique `eventId`)

### Inventory Transactions (`src/inventory/transaction.js`)
- MongoDB transactions for atomic inventory operations
- `reserveCheckoutIntent` — Atomically decrements available quantity, creates intent
- `releaseIntentReservation` — Releases reservation on cancel/expiry
- `confirmBooking` — Converts intent to booking (called from webhook)

## Deployment

- **Platform:** Vercel (serverless)
- **Backend URL:** https://server-uzzal6090.vercel.app/
- **Build Command:** None (Vercel detects `server.js` export)
- **Output:** Serverless function
- **Environment Variables:** Configure all required variables in Vercel project settings
- **CORS:** `CLIENT_URL` must be set to production frontend origin

### Vercel-Specific Behavior
- `server.js` exports `app` as default; Vercel consumes this directly
- `startServer()` only runs locally (`process.env.VERCEL !== "1"`)
- `VERCEL=1` is auto-injected by Vercel platform
- Database connections are lazily initialized per invocation

---

*Generated for Assignment 9 — Equipment Rental Platform*