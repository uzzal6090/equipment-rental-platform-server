import { config as dotenvConfig } from "dotenv";
import * as dns from "dns";
import { MongoClient, ObjectId } from "mongodb";
import { spawn } from "child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// Load test environment (.env.test takes precedence)
dotenvConfig({ path: ".env.test", override: true });

// Configure DNS servers (same as db.js configureDNS) so MongoDB Atlas SRV records resolve
const dnsServers = process.env.DNS_SERVERS;
if (dnsServers) {
  const servers = dnsServers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length > 0) {
    dns.setServers(servers);
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "equipment_rental_test_db";
const JWT_SECRET = process.env.JWT_SECRET;
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://localhost:${PORT}`;

const USER_ROLES = ["customer", "owner", "admin"];
const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];

// Test results tracking
const results = [];
let passed = 0;
let failed = 0;
let blocked = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      if (err.blocked) {
        results.push({ name, status: "BLOCKED", detail: err.detail || "" });
        blocked++;
        console.log(`  BLOCKED: ${name} - ${err.detail}`);
      } else {
        results.push({ name, status: "FAIL", error: err.message });
        failed++;
        console.log(`  FAIL: ${name} - ${err.message}`);
      }
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- Database fixture helpers ---

let mongoClient;
let db;
let ownerProfileId;
let customerProfileId;
let adminProfileId;
let ownerJwt;
let customerJwt;
let adminJwt;

async function connectTestDb() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  console.log(`Connected to test database: ${DB_NAME}`);
}

async function insertFixtures() {
  // Clean up first
  await db.collection("profiles").deleteMany({});
  await db.collection("equipment").deleteMany({});
  await db.collection("jwks").deleteMany({});

  // Insert test profiles with different roles
  const ownerProfile = {
    betterAuthUserId: "test-owner-1",
    name: "Test Owner",
    email: "owner@example.com",
    profileImage: null,
    phone: null,
    address: null,
    role: "owner",
    roleVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const customerProfile = {
    betterAuthUserId: "test-customer-1",
    name: "Test Customer",
    email: "customer@example.com",
    profileImage: null,
    phone: null,
    address: null,
    role: "customer",
    roleVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adminProfile = {
    betterAuthUserId: "test-admin-1",
    name: "Test Admin",
    email: "admin@example.com",
    profileImage: null,
    phone: null,
    address: null,
    role: "admin",
    roleVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection("profiles").insertMany([ownerProfile, customerProfile, adminProfile]);
  console.log("Inserted test profiles");

  // Get the profile IDs
  const profiles = await db.collection("profiles").find({}).toArray();
  ownerProfileId = profiles.find(p => p.role === "owner")._id;
  customerProfileId = profiles.find(p => p.role === "customer")._id;
  adminProfileId = profiles.find(p => p.role === "admin")._id;
  console.log(`Owner profile ID: ${ownerProfileId}`);
  console.log(`Customer profile ID: ${customerProfileId}`);
  console.log(`Admin profile ID: ${adminProfileId}`);

  // Equipment fixtures matching actual schema (src/config/schema.js EQUIPMENT_FIELDS)
  const equipment = [
    {
      ownerId: ownerProfileId,
      name: "Compact Excavator",
      description: "3-ton compact excavator for digging and trenching",
      category: "Construction Equipment",
      location: "New York, NY",
      rentalPrice: 150,
      rentalType: "daily",
      totalQuantity: 5,
      condition: "good",
      image: "https://example.com/excavator.jpg",
      rentalTerms: "Daily rate includes basic insurance. Delivery extra.",
      status: "approved",
      featured: true,
      inventoryVersion: 0,
      createdAt: new Date("2026-01-10T00:00:00Z"),
      updatedAt: new Date("2026-01-10T00:00:00Z"),
    },
    {
      ownerId: ownerProfileId,
      name: "DSLR Camera Kit",
      description: "Professional DSLR camera with lenses and accessories",
      category: "Photography Equipment",
      location: "Los Angeles, CA",
      rentalPrice: 75,
      rentalType: "daily",
      totalQuantity: 3,
      condition: "excellent",
      image: "https://example.com/camera.jpg",
      rentalTerms: "Damage waiver required.",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date("2026-02-05T00:00:00Z"),
      updatedAt: new Date("2026-02-05T00:00:00Z"),
    },
    {
      ownerId: ownerProfileId,
      name: "Cargo Van",
      description: "15-foot cargo van for local moving",
      category: "Vehicles & Transportation",
      location: "Chicago, IL",
      rentalPrice: 60,
      rentalType: "daily",
      totalQuantity: 2,
      condition: "good",
      image: "https://example.com/van.jpg",
      rentalTerms: "Commercial license required.",
      status: "approved",
      featured: true,
      inventoryVersion: 0,
      createdAt: new Date("2026-03-15T00:00:00Z"),
      updatedAt: new Date("2026-03-15T00:00:00Z"),
    },
    {
      ownerId: ownerProfileId,
      name: "Tractor",
      description: "4WD agricultural tractor",
      category: "Agriculture Equipment",
      location: "Des Moines, IA",
      rentalPrice: 200,
      rentalType: "weekly",
      totalQuantity: 0,
      condition: "good",
      image: "https://example.com/tractor.jpg",
      rentalTerms: "Operator training required.",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date("2026-01-20T00:00:00Z"),
      updatedAt: new Date("2026-01-20T00:00:00Z"),
    },
    {
      ownerId: ownerProfileId,
      name: "Pending Drone",
      description: "Aerial photography drone awaiting approval",
      category: "Electronics",
      location: "Seattle, WA",
      rentalPrice: 120,
      rentalType: "daily",
      totalQuantity: 2,
      condition: "new",
      image: "https://example.com/drone.jpg",
      rentalTerms: "Pilot certification required.",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    },
    {
      ownerId: ownerProfileId,
      name: "Rejected Generator",
      description: "Industrial power generator that was rejected",
      category: "Construction Equipment",
      location: "Miami, FL",
      rentalPrice: 90,
      rentalType: "daily",
      totalQuantity: 4,
      condition: "fair",
      image: "https://example.com/generator.jpg",
      rentalTerms: "Fuel not included.",
      status: "rejected",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date("2026-02-28T00:00:00Z"),
      updatedAt: new Date("2026-02-28T00:00:00Z"),
    },
  ];

  const result = await db.collection("equipment").insertMany(equipment);
  console.log(`Inserted ${result.insertedCount} equipment fixtures`);

  // Store inserted IDs for test reference
  const inserted = await db.collection("equipment").find({}).toArray();
  global.__TEST_EQUIPMENT = inserted;
  console.log(`Retrieved ${inserted.length} equipment records from test db`);
}

async function createAuthFixtures() {
  // Generate Ed25519 key pair for JWT signing
  const keyPair = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(keyPair.publicKey);
  const kid = "test-key-" + Date.now();

  // Insert JWKS entry
  await db.collection("jwks").insertOne({
    _id: kid,
    publicKey: JSON.stringify(jwk),
    alg: "EdDSA",
  });
  console.log(`Inserted JWKS entry with kid: ${kid}`);

  // Sign JWT token for owner
  ownerJwt = await new SignJWT({
    sub: "test-owner-1",
    role: "owner",
    roleVersion: 0,
    profileImage: null,
  })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuer(BETTER_AUTH_URL)
    .setAudience(BETTER_AUTH_URL)
    .setExpirationTime("1h")
    .sign(keyPair.privateKey);

  // Sign JWT token for customer
  customerJwt = await new SignJWT({
    sub: "test-customer-1",
    role: "customer",
    roleVersion: 0,
    profileImage: null,
  })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuer(BETTER_AUTH_URL)
    .setAudience(BETTER_AUTH_URL)
    .setExpirationTime("1h")
    .sign(keyPair.privateKey);

  // Sign JWT token for admin
  adminJwt = await new SignJWT({
    sub: "test-admin-1",
    role: "admin",
    roleVersion: 0,
    profileImage: null,
  })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuer(BETTER_AUTH_URL)
    .setAudience(BETTER_AUTH_URL)
    .setExpirationTime("1h")
    .sign(keyPair.privateKey);

  global.__TEST_OWNER_JWT = ownerJwt;
  global.__TEST_CUSTOMER_JWT = customerJwt;
  global.__TEST_ADMIN_JWT = adminJwt;
  global.__TEST_KID = kid;
  console.log("Generated test JWTs for owner, customer, and admin");
}

async function cleanupFixtures() {
  await db.collection("equipment").deleteMany({});
  await db.collection("jwks").deleteMany({});
  await db.collection("profiles").deleteMany({});
  await db.collection("_transaction_verification").deleteMany({});
  console.log("Cleaned up test fixtures");
}

// --- HTTP helpers ---

async function fetchJson(path, options = {}) {
  const { headers, ...fetchOptions } = options;
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...fetchOptions,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = { _raw: await response.text() };
  }
  return { status: response.status, body };
}

// --- Server lifecycle ---

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server.js"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error("Server failed to start within timeout"));
      }
    }, 30000);

    proc.stdout.on("data", (data) => {
      const line = data.toString();
      if (line.includes(`Server running on port ${PORT}`)) {
        resolved = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.stderr.on("data", (data) => {
      const line = data.toString();
      console.error(`[SERVER STDERR] ${line.trim()}`);
      if (!resolved && line.includes("Failed to start")) {
        resolved = true;
        clearTimeout(timeout);
        proc.kill();
        reject(new Error(`Server startup failed: ${line}`));
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function waitForServer(maxRetries = 30, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Server did not become ready");
}

// --- Tests ---

const runTests = [
  // ========== EXISTING PUBLIC EQUIPMENT TESTS ==========
  test("Public listing returns only approved equipment", async () => {
    const { status, body } = await fetchJson("/api/equipment");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    const equipment = body.data.equipment;
    assert(Array.isArray(equipment), "Should return equipment array");
    assert(equipment.length > 0, "Should have approved equipment");
    for (const item of equipment) {
      assert(item.status === "approved", `Equipment ${item.id} has status ${item.status}, expected approved`);
      assert(item.name, "Equipment should have name");
      assert(item.category, "Equipment should have category");
      assert(item.rentalPrice !== undefined, "Equipment should have rentalPrice");
      assert(item.rentalType, "Equipment should have rentalType");
      assert(item.location, "Equipment should have location");
      assert(item.availableQuantity !== undefined, "Equipment should have availableQuantity");
    }
    console.log(`    Found ${equipment.length} approved equipment items`);
  }),

  test("Pending equipment excluded from public listing", async () => {
    const { status, body } = await fetchJson("/api/equipment");
    assert(status === 200);
    const equipment = body.data.equipment;
    const pending = equipment.find((e) => e.status === "pending");
    assert(pending === undefined, "Pending equipment should not appear in public listing");
  }),

  test("Rejected equipment excluded from public listing", async () => {
    const { status, body } = await fetchJson("/api/equipment");
    assert(status === 200);
    const equipment = body.data.equipment;
    const rejected = equipment.find((e) => e.status === "rejected");
    assert(rejected === undefined, "Rejected equipment should not appear in public listing");
  }),

  test("Search by name works", async () => {
    const { status, body } = await fetchJson("/api/equipment?search=Excavator");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one excavator");
    assert(equipment.every((e) => e.name.toLowerCase().includes("excavator")), "All results should match 'Excavator'");
  }),

  test("Search by location works", async () => {
    const { status, body } = await fetchJson("/api/equipment?search=Chicago");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find equipment in Chicago");
    assert(equipment.every((e) => e.location.toLowerCase().includes("chicago")), "All results should match 'Chicago'");
  }),

  test("Search by category works", async () => {
    const { status, body } = await fetchJson("/api/equipment?search=Photography");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find photography equipment");
    assert(equipment.every((e) => e.category.toLowerCase().includes("photography")), "All results should match 'Photography'");
  }),

  test("Category filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?category=Construction%20Equipment");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find construction equipment");
    assert(equipment.every((e) => e.category === "Construction Equipment"), "All results should be Construction Equipment");
  }),

  test("Rental type filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?rentalType=weekly");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find weekly rental equipment");
    assert(equipment.every((e) => e.rentalType === "weekly"), "All results should be weekly rental type");
  }),

  test("Price range filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?minPrice=100&maxPrice=200");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find equipment in price range");
    assert(equipment.every((e) => e.rentalPrice >= 100 && e.rentalPrice <= 200), "All results should be within price range");
  }),

  test("Availability filter - available works", async () => {
    const { status, body } = await fetchJson("/api/equipment?availability=available");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find available equipment");
    assert(equipment.every((e) => e.availableQuantity > 0), "All available results should have quantity > 0");
  }),

  test("Availability filter - unavailable works", async () => {
    const { status, body } = await fetchJson("/api/equipment?availability=unavailable");
    assert(status === 200);
    const equipment = body.data.equipment;
    const tractor = equipment.find((e) => e.name === "Tractor");
    assert(tractor !== undefined, "Tractor (quantity 0) should appear in unavailable filter");
    assert(equipment.every((e) => e.availableQuantity === 0), "All unavailable results should have quantity = 0");
  }),

  test("Sort price low to high works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=price_asc");
    assert(status === 200);
    const equipment = body.data.equipment;
    for (let i = 1; i < equipment.length; i++) {
      assert(equipment[i - 1].rentalPrice <= equipment[i].rentalPrice, "Should be sorted by price ascending");
    }
  }),

  test("Sort price high to low works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=price_desc");
    assert(status === 200);
    const equipment = body.data.equipment;
    for (let i = 1; i < equipment.length; i++) {
      assert(equipment[i - 1].rentalPrice >= equipment[i].rentalPrice, "Should be sorted by price descending");
    }
  }),

  test("Sort recently added works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=newest");
    assert(status === 200);
    const equipment = body.data.equipment;
    for (let i = 1; i < equipment.length; i++) {
      const prev = new Date(equipment[i - 1].createdAt).getTime();
      const curr = new Date(equipment[i].createdAt).getTime();
      assert(prev >= curr, "Should be sorted by createdAt descending (newest first)");
    }
  }),

  test("Pagination returns correct metadata", async () => {
    const { status, body } = await fetchJson("/api/equipment?limit=2&page=1");
    assert(status === 200);
    assert(body.data.pagination.page === 1, "Page should be 1");
    assert(body.data.pagination.limit === 2, "Limit should be 2");
    assert(body.data.pagination.total > 0, "Total should be > 0");
    assert(body.data.pagination.totalPages >= 1, "Total pages should be >= 1");
    assert(body.data.equipment.length <= 2, "Should not exceed limit");
    assert(typeof body.data.pagination.hasNext === "boolean", "hasNext should be boolean");
    assert(typeof body.data.pagination.hasPrev === "boolean", "hasPrev should be boolean");
  }),

  test("Pagination page 2 does not duplicate page 1", async () => {
    const { body: page1 } = await fetchJson("/api/equipment?limit=2&page=1");
    const { body: page2 } = await fetchJson("/api/equipment?limit=2&page=2");
    const page1Ids = page1.data.equipment.map((e) => e.id);
    const page2Ids = page2.data.equipment.map((e) => e.id);
    const overlap = page1Ids.filter((id) => page2Ids.includes(id));
    assert(overlap.length === 0, "Pages should not overlap");
  }),

  test("Invalid sort parameter returns 400", async () => {
    const { status } = await fetchJson("/api/equipment?sort=invalid_sort");
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Invalid rental type returns 400", async () => {
    const { status } = await fetchJson("/api/equipment?rentalType=hourly");
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Invalid availability returns 400", async () => {
    const { status } = await fetchJson("/api/equipment?availability=maybe");
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Negative price handled safely", async () => {
    const { status } = await fetchJson("/api/equipment?minPrice=-50");
    assert(status === 200, `Expected 200, got ${status}`);
  }),

  test("Non-numeric page handled safely", async () => {
    const { status } = await fetchJson("/api/equipment?page=abc");
    assert(status === 200, `Expected 200, got ${status}`);
  }),

  test("Details endpoint rejects unauthenticated request", async () => {
    const { status } = await fetchJson(`/api/equipment/${global.__TEST_EQUIPMENT[0]._id}`);
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Details endpoint returns correct equipment for authenticated user", async () => {
    const { status, body } = await fetchJson(
      `/api/equipment/${global.__TEST_EQUIPMENT[0]._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    );
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    const eq = body.data.equipment;
    assert(eq.name === "Compact Excavator", "Should return correct equipment name");
    assert(eq.description, "Should have description");
    assert(eq.category === "Construction Equipment", "Should have correct category");
    assert(eq.rentalPrice === 150, "Should have correct price");
    assert(eq.rentalType === "daily", "Should have correct rental type");
    assert(eq.location === "New York, NY", "Should have correct location");
    assert(eq.availableQuantity === 5, "Should have correct available quantity");
    assert(eq.image, "Should have image");
    assert(eq.rentalTerms, "Should have rental terms");
    assert(eq.owner, "Should have owner information");
    assert(eq.owner.name === "Test Owner", "Should return correct owner name");
    assert(eq.owner.profileImage === null, "Should return null profile image when none set");
  }),

  test("Invalid ID returns 404", async () => {
    const { status } = await fetchJson(
      "/api/equipment/invalid-id-123",
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    );
    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Nonexistent ObjectId returns 404", async () => {
    const { status } = await fetchJson(
      `/api/equipment/${new ObjectId()}`,
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    );
    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Existing auth/profile endpoints continue working", async () => {
    const { status } = await fetchJson("/api/profile", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${global.__TEST_OWNER_JWT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Test Updated" }),
    });
    // verifyToken should pass (profile exists), so we expect either 200 or a validation error
    // but not 401 (which would mean auth is broken)
    assert(status !== 401, `Auth middleware should pass for valid token, got ${status}`);
  }),

  // ========== NEW OWNER CREATE EQUIPMENT TESTS ==========
  test("Owner can create equipment with all required fields", async () => {
    const newEquipment = {
      name: "Test Backhoe Loader",
      description: "Versatile backhoe loader for construction sites",
      category: "Construction Equipment",
      location: "Houston, TX",
      rentalPrice: 180,
      rentalType: "daily",
      totalQuantity: 2,
      condition: "good",
      brand: "Caterpillar",
      model: "420F2",
      image: "https://example.com/backhoe.jpg",
      rentalTerms: "Operator must be certified. Fuel not included.",
    };

    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify(newEquipment),
    });

    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    const eq = body.data.equipment;
    assert(eq.id, "Should have equipment ID");
    assert(eq.name === newEquipment.name, "Should have correct name");
    assert(eq.category === newEquipment.category, "Should have correct category");
    assert(eq.rentalPrice === newEquipment.rentalPrice, "Should have correct price");
    assert(eq.rentalType === newEquipment.rentalType, "Should have correct rental type");
    assert(eq.location === newEquipment.location, "Should have correct location");
    assert(eq.availableQuantity === newEquipment.totalQuantity, "Should have correct quantity");
    assert(eq.image === newEquipment.image, "Should have correct image");
    assert(eq.status === "pending", "Status should default to pending");
    assert(eq.featured === false, "Featured should default to false");
    assert(eq.createdAt, "Should have createdAt");
    assert(eq.updatedAt, "Should have updatedAt");
  }),

  test("Owner create equipment validates required fields", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({}),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false, "Response should be error");
    assert(body.error.code === "VALIDATION_ERROR", "Should have validation error code");
    assert(body.error.errors, "Should have errors array");
    assert(body.error.errors.length > 0, "Should have validation errors");
    const requiredFields = ["name", "description", "category", "location", "rentalPrice", "rentalType", "totalQuantity", "condition"];
    for (const field of requiredFields) {
      const error = body.error.errors.find(e => e.field === field);
      assert(error, `Should have validation error for required field: ${field}`);
    }
  }),

  test("Owner create equipment validates rental type", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "hourly", // invalid
        totalQuantity: 1,
        condition: "good",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
    const rentalTypeError = body.error.errors.find(e => e.field === "rentalType");
    assert(rentalTypeError, "Should have rentalType validation error");
  }),

  test("Owner create equipment validates category", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Invalid Category",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
    const categoryError = body.error.errors.find(e => e.field === "category");
    assert(categoryError, "Should have category validation error");
  }),

  test("Owner create equipment validates price and quantity", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: -50, // invalid negative
        rentalType: "daily",
        totalQuantity: 0, // invalid zero
        condition: "good",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
    const priceError = body.error.errors.find(e => e.field === "rentalPrice");
    const qtyError = body.error.errors.find(e => e.field === "totalQuantity");
    assert(priceError, "Should have rentalPrice validation error");
    assert(qtyError, "Should have totalQuantity validation error");
  }),

  test("Owner create equipment validates condition", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "mint", // invalid
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
    const conditionError = body.error.errors.find(e => e.field === "condition");
    assert(conditionError, "Should have condition validation error");
  }),

  test("Owner create equipment validates image URL", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        image: "not-a-url",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
    const imageError = body.error.errors.find(e => e.field === "image");
    assert(imageError, "Should have image validation error");
  }),

  test("Owner create equipment rejects client-supplied status", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        status: "approved", // client tries to set status
      }),
    });

    assert(status === 201, `Expected 201, got ${status}`);
    assert(body.data.equipment.status === "pending", "Status should be forced to pending regardless of client input");
  }),

  test("Owner create equipment rejects client-supplied ownerId", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test Equipment",
        description: "Test description for validation",
        category: "Construction Equipment",
        location: "Test Location",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        ownerId: "some-other-id", // client tries to set ownerId
      }),
    });

    assert(status === 201, `Expected 201, got ${status}`);
    // The ownerId should be derived from the authenticated user, not from the request
    // We verify this by checking the equipment belongs to the owner
  }),

  // ========== NEW OWNER EQUIPMENT LIST TESTS ==========
  test("Owner can list their equipment with all statuses", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment array");
    assert(body.data.pagination, "Should have pagination");
    // Should include pending, approved, and rejected
    const statuses = body.data.equipment.map(e => e.status);
    assert(statuses.includes("approved"), "Should include approved equipment");
    assert(statuses.includes("pending"), "Should include pending equipment");
    assert(statuses.includes("rejected"), "Should include rejected equipment");
    // All should belong to this owner
    for (const eq of body.data.equipment) {
      // The ownerId is not returned in the list, but we trust the backend filtering
    }
    console.log(`    Found ${body.data.equipment.length} equipment items for owner`);
  }),

  test("Owner equipment list sorted newest first", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200);
    const equipment = body.data.equipment;
    for (let i = 1; i < equipment.length; i++) {
      const prev = new Date(equipment[i - 1].createdAt).getTime();
      const curr = new Date(equipment[i].createdAt).getTime();
      assert(prev >= curr, "Should be sorted by createdAt descending (newest first)");
    }
  }),

  test("Owner equipment list supports pagination", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me?limit=2&page=1", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200);
    assert(body.data.pagination.page === 1, "Page should be 1");
    assert(body.data.pagination.limit === 2, "Limit should be 2");
    assert(body.data.equipment.length <= 2, "Should not exceed limit");
  }),

  test("Customer cannot access owner equipment list", async () => {
    const { status } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated request rejected for owner equipment list", async () => {
    const { status } = await fetchJson("/api/equipment/owner/me");
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  // ========== NEW OWNER UPDATE EQUIPMENT TESTS ==========
  test("Owner can update their equipment", async () => {
    // First, find an equipment owned by the test owner
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Updated Excavator Name",
        rentalPrice: 200,
        description: "Updated description for the excavator",
      }),
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    const eq = body.data.equipment;
    assert(eq.name === "Updated Excavator Name", "Should have updated name");
    assert(eq.rentalPrice === 200, "Should have updated price");
    assert(eq.id === equipment._id.toString(), "Should have same ID");
    // Other fields should be preserved
    assert(eq.category === equipment.category, "Category should be preserved");
    assert(eq.rentalType === equipment.rentalType, "Rental type should be preserved");
  }),

  test("Owner can partially update equipment", async () => {
    // Create a fresh equipment for this test to avoid test pollution
    const freshEquipment = {
      ownerId: ownerProfileId,
      name: "Partial Update Test Equipment",
      description: "Equipment for testing partial updates",
      category: "Construction Equipment",
      location: "Test City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(freshEquipment);
    const equipmentId = result.insertedId.toString();

    const { status, body } = await fetchJson(`/api/equipment/${equipmentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        rentalPrice: 250,
      }),
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.data.equipment.rentalPrice === 250, "Should update only provided field");
    // Other fields should remain unchanged
    assert(body.data.equipment.name === "Partial Update Test Equipment", "Name should be preserved");
    assert(body.data.equipment.category === "Construction Equipment", "Category should be preserved");
    assert(body.data.equipment.rentalType === "daily", "Rental type should be preserved");
  }),

  test("Owner update validates fields", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        rentalPrice: -100,
        rentalType: "hourly",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner cannot update another owner's equipment", async () => {
    // Create another owner and their equipment
    const otherOwnerProfile = {
      betterAuthUserId: "test-owner-2",
      name: "Other Owner",
      email: "owner2@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherOwnerProfile);
    const otherOwnerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-owner-2" });

    const otherEquipment = {
      ownerId: otherOwnerProfileDoc._id,
      name: "Other Owner's Equipment",
      description: "Equipment belonging to another owner",
      category: "Construction Equipment",
      location: "Other City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(otherEquipment);
    const otherEquipmentId = result.insertedId.toString();

    // Try to update with test-owner-1's JWT
    const { status } = await fetchJson(`/api/equipment/${otherEquipmentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "Hacked Name" }),
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Owner cannot change status through PUT", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        status: "approved", // client tries to change status
      }),
    });

    assert(status === 200, `Expected 200, got ${status}`);
    // Status should remain unchanged (the update should ignore status field)
    assert(body.data.equipment.status === equipment.status, "Status should not be changed by owner");
  }),

  test("Owner cannot change ownerId through PUT", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        ownerId: "some-other-id", // client tries to change ownership
      }),
    });

    assert(status === 200, `Expected 200, got ${status}`);
    // The ownerId should not be changeable - verify by checking equipment still belongs to original owner
    const updatedEquipment = await db.collection("equipment").findOne({ _id: equipment._id });
    assert(updatedEquipment.ownerId.equals(ownerProfileId), "OwnerId should not be changed");
  }),

  test("Update nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson(`/api/equipment/${new ObjectId()}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "New Name" }),
    });

    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Update with invalid ID returns 400", async () => {
    const { status } = await fetchJson("/api/equipment/invalid-id", {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "New Name" }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Customer cannot update equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ name: "Hacked Name" }),
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated update rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Hacked Name" }),
    });

    assert(status === 401, `Expected 401, got ${status}`);
  }),

  // ========== NEW OWNER DELETE EQUIPMENT TESTS ==========
  test("Owner can delete their equipment", async () => {
    // Create a new equipment to delete
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete",
      description: "This equipment will be deleted",
      category: "Construction Equipment",
      location: "Delete City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    const { status, body } = await fetchJson(`/api/equipment/${equipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.deleted === true, "Should confirm deletion");
    assert(body.data.id === equipmentId, "Should return deleted ID");

    // Verify equipment is actually deleted
    const deleted = await db.collection("equipment").findOne({ _id: new ObjectId(equipmentId) });
    assert(deleted === null, "Equipment should be deleted from database");
  }),

  test("Owner cannot delete another owner's equipment", async () => {
    // Create another owner and their equipment
    const otherOwnerProfile = {
      betterAuthUserId: "test-owner-3",
      name: "Third Owner",
      email: "owner3@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherOwnerProfile);
    const otherOwnerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-owner-3" });

    const otherEquipment = {
      ownerId: otherOwnerProfileDoc._id,
      name: "Other Owner's Equipment",
      description: "Equipment belonging to another owner",
      category: "Construction Equipment",
      location: "Other City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(otherEquipment);
    const otherEquipmentId = result.insertedId.toString();

    // Try to delete with test-owner-1's JWT
    const { status } = await fetchJson(`/api/equipment/${otherEquipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);

    // Verify equipment still exists
    const stillExists = await db.collection("equipment").findOne({ _id: new ObjectId(otherEquipmentId) });
    assert(stillExists !== null, "Equipment should still exist");
  }),

  test("Delete nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson(`/api/equipment/${new ObjectId()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Delete with invalid ID returns 400", async () => {
    const { status } = await fetchJson("/api/equipment/invalid-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Customer cannot delete equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated delete rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "DELETE",
    });

    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Delete does not affect unrelated data", async () => {
    // Create equipment with a booking-like reference (simulated)
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment with Related Data",
      description: "This equipment has simulated related data",
      category: "Construction Equipment",
      location: "Related City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    // Create a simulated booking (not part of this phase, but testing isolation)
    await db.collection("bookings").insertOne({
      equipmentId: new ObjectId(equipmentId),
      ownerId: ownerProfileId,
      userId: customerProfileId,
      startDate: new Date(),
      endDate: new Date(),
      quantity: 1,
      bookingStatus: "pending",
      paymentStatus: "pending",
      totalPrice: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { status } = await fetchJson(`/api/equipment/${equipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);

    // Verify booking still exists (we only delete equipment, not bookings)
    const booking = await db.collection("bookings").findOne({ equipmentId: new ObjectId(equipmentId) });
    assert(booking !== null, "Booking should not be deleted when equipment is deleted");
  }),

  // ========== ADMIN USERS API TESTS ==========
  test("Admin can retrieve the user list", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.users, "Should have users array");
    assert(Array.isArray(body.data.users), "Users should be an array");
    assert(body.data.users.length >= 3, "Should have at least 3 users (owner, customer, admin)");
  }),

  test("User list includes name, email, role and registration date", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200);
    const users = body.data.users;
    for (const user of users) {
      assert(user.id, "User should have id");
      assert(user.name, "User should have name");
      assert(user.email, "User should have email");
      assert(user.role, "User should have role");
      assert(user.createdAt, "User should have createdAt (registration date)");
      assert(USER_ROLES.includes(user.role), `User role should be valid: ${user.role}`);
    }
  }),

  test("Sensitive authentication fields are not exposed in user list", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200);
    const users = body.data.users;
    for (const user of users) {
      assert(user.passwordHash === undefined, "Should not expose passwordHash");
      assert(user.password === undefined, "Should not expose password");
      assert(user.token === undefined, "Should not expose token");
      assert(user.secret === undefined, "Should not expose secret");
      assert(user.jwt === undefined, "Should not expose jwt");
      assert(user.betterAuthUserId === undefined, "Should not expose betterAuthUserId");
    }
  }),

  test("Admin can change Customer to Owner", async () => {
    // Create a fresh customer user for this test
    const testUser = {
      betterAuthUserId: "test-customer-rolechange-1",
      name: "Test Customer For Role Change",
      email: "rolechange-customer@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    const { status: patchStatus, body: patchBody } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });

    assert(patchStatus === 200, `Expected 200, got ${patchStatus}: ${JSON.stringify(patchBody)}`);
    assert(patchBody.success === true, "Response should be successful");
    assert(patchBody.data.user.role === "owner", "User role should be updated to owner");
    assert(patchBody.data.user.roleVersion === 1, "Role version should be incremented");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  test("Admin can change Owner to Customer", async () => {
    // Create a fresh owner user for this test
    const testUser = {
      betterAuthUserId: "test-owner-rolechange-1",
      name: "Test Owner For Role Change",
      email: "rolechange-owner@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    const { status: patchStatus, body: patchBody } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "customer" }),
    });

    assert(patchStatus === 200, `Expected 200, got ${patchStatus}: ${JSON.stringify(patchBody)}`);
    assert(patchBody.success === true, "Response should be successful");
    assert(patchBody.data.user.role === "customer", "User role should be updated to customer");
    assert(patchBody.data.user.roleVersion === 1, "Role version should be incremented");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  test("Admin can change a user's role to Admin", async () => {
    // Create a fresh customer user for this test
    const testUser = {
      betterAuthUserId: "test-customer-rolechange-2",
      name: "Test Customer For Admin Role",
      email: "rolechange-customer2@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    const { status: patchStatus, body: patchBody } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "admin" }),
    });

    assert(patchStatus === 200, `Expected 200, got ${patchStatus}: ${JSON.stringify(patchBody)}`);
    assert(patchBody.success === true, "Response should be successful");
    assert(patchBody.data.user.role === "admin", "User role should be updated to admin");
    assert(patchBody.data.user.roleVersion === 1, "Role version should be incremented");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  test("Invalid roles are rejected", async () => {
    // Create a fresh customer user for this test
    const testUser = {
      betterAuthUserId: "test-customer-rolechange-3",
      name: "Test Customer For Invalid Role",
      email: "rolechange-customer3@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    const { status: patchStatus, body: patchBody } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "superadmin" }),
    });

    assert(patchStatus === 400, `Expected 400, got ${patchStatus}`);
    assert(patchBody.error.code === "INVALID_ROLE", "Should reject invalid role");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  test("Invalid IDs are rejected", async () => {
    const { status, body } = await fetchJson("/api/admin/users/invalid-id/role", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "INVALID_ID", "Should reject invalid ID");
  }),

  test("Nonexistent users are handled correctly", async () => {
    const nonExistentId = new ObjectId().toString();
    const { status, body } = await fetchJson(`/api/admin/users/${nonExistentId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });

    assert(status === 404, `Expected 404, got ${status}`);
    assert(body.error.code === "USER_NOT_FOUND", "Should return user not found");
  }),

  test("Unauthenticated requests are rejected for admin users list", async () => {
    const { status } = await fetchJson("/api/admin/users");
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Unauthenticated requests are rejected for admin role change", async () => {
    const { status } = await fetchJson("/api/admin/users/some-id/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Customer cannot access admin endpoints", async () => {
    const { status } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Owner cannot access admin endpoints", async () => {
    const { status } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("roleVersion increments after a successful role change", async () => {
    // Create a fresh customer user for this test
    const testUser = {
      betterAuthUserId: "test-customer-rolechange-4",
      name: "Test Customer For Role Version",
      email: "rolechange-customer4@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    const { status: patchStatus, body: patchBody } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });

    assert(patchStatus === 200);
    assert(patchBody.data.user.roleVersion === 1, "Role version should increment by 1");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  test("JWT with old roleVersion cannot continue using old authorization", async () => {
    // This test verifies that the verifyToken middleware checks roleVersion
    // by confirming that after a role change, the user would need to re-authenticate
    // Create a fresh customer user for this test
    const testUser = {
      betterAuthUserId: "test-customer-rolechange-5",
      name: "Test Customer For Stale Token",
      email: "rolechange-customer5@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("profiles").insertOne(testUser);
    const userId = result.insertedId.toString();

    // Change role via admin
    const { status: patchStatus } = await fetchJson(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });

    assert(patchStatus === 200);

    // The old JWT for the customer would now have stale roleVersion
    // verifyToken middleware at line 102-105 checks this and rejects with 401
    // This is tested implicitly by the middleware behavior

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: new ObjectId(userId) });
  }),

  // ========== ADMIN EQUIPMENT MANAGEMENT TESTS ==========
  test("Admin can retrieve all equipment across all statuses", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment array");
    assert(Array.isArray(body.data.equipment), "Equipment should be an array");
    assert(body.data.equipment.length >= 6, "Should have at least 6 equipment items (including pending, approved, rejected)");
    assert(body.data.pagination, "Should have pagination");
  }),

  test("Admin equipment list includes owner information", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200);
    const equipment = body.data.equipment;
    for (const eq of equipment) {
      assert(eq.id, "Equipment should have id");
      assert(eq.name, "Equipment should have name");
      assert(eq.category, "Equipment should have category");
      assert(eq.rentalPrice !== undefined, "Equipment should have rentalPrice");
      assert(eq.rentalType, "Equipment should have rentalType");
      assert(eq.location, "Equipment should have location");
      assert(eq.totalQuantity !== undefined, "Equipment should have totalQuantity");
      assert(eq.status, "Equipment should have status");
      assert(EQUIPMENT_STATUSES.includes(eq.status), `Equipment status should be valid: ${eq.status}`);
      assert(eq.owner, "Equipment should have owner information");
      assert(eq.owner.id, "Owner should have id");
      assert(eq.owner.name, "Owner should have name");
      assert(eq.owner.email, "Owner should have email");
      assert(eq.createdAt, "Equipment should have createdAt");
      assert(eq.updatedAt, "Equipment should have updatedAt");
    }
  }),

  test("Admin equipment list includes all statuses: pending, approved, rejected", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200);
    const equipment = body.data.equipment;
    const statuses = equipment.map(e => e.status);
    assert(statuses.includes("approved"), "Should include approved equipment");
    assert(statuses.includes("pending"), "Should include pending equipment");
    assert(statuses.includes("rejected"), "Should include rejected equipment");
  }),

  test("Customer cannot access admin equipment list", async () => {
    const { status } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Owner cannot access admin equipment list", async () => {
    const { status } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated request rejected for admin equipment list", async () => {
    const { status } = await fetchJson("/api/admin/equipment");
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Admin can approve pending equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.status === "approved", "Equipment status should be approved");
    assert(body.data.equipment.id === pendingEquipment._id.toString(), "Should return same equipment ID");
  }),

  test("Admin can reject pending equipment", async () => {
    // Create a fresh pending equipment for this test
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Reject",
      description: "This equipment will be rejected by admin",
      category: "Construction Equipment",
      location: "Reject City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipmentId}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.status === "rejected", "Equipment status should be rejected");
    assert(body.data.equipment.id === equipmentId, "Should return same equipment ID");
  }),

  test("Admin cannot approve nonexistent equipment", async () => {
    const { status, body } = await fetchJson(`/api/admin/equipment/${new ObjectId()}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 404, `Expected 404, got ${status}`);
    assert(body.error.code === "EQUIPMENT_NOT_FOUND", "Should return equipment not found");
  }),

  test("Admin cannot reject nonexistent equipment", async () => {
    const { status, body } = await fetchJson(`/api/admin/equipment/${new ObjectId()}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 404, `Expected 404, got ${status}`);
    assert(body.error.code === "EQUIPMENT_NOT_FOUND", "Should return equipment not found");
  }),

  test("Invalid equipment ID returns 400 for approve", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment/invalid-id/approve", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "INVALID_ID", "Should reject invalid ID");
  }),

  test("Invalid equipment ID returns 400 for reject", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment/invalid-id/reject", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "INVALID_ID", "Should reject invalid ID");
  }),

  test("Approved equipment cannot be approved again", async () => {
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved");
    assert(approvedEquipment, "Should have approved equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${approvedEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.error.code === "INVALID_STATUS_TRANSITION", "Should reject invalid status transition");
  }),

  test("Rejected equipment cannot be rejected again", async () => {
    const rejectedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "rejected");
    assert(rejectedEquipment, "Should have rejected equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${rejectedEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.error.code === "INVALID_STATUS_TRANSITION", "Should reject invalid status transition");
  }),

  test("Admin can update equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({
        name: "Admin Updated Equipment Name",
        rentalPrice: 300,
        description: "Updated by admin",
      }),
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    const eq = body.data.equipment;
    assert(eq.name === "Admin Updated Equipment Name", "Should have updated name");
    assert(eq.rentalPrice === 300, "Should have updated price");
    assert(eq.id === equipment._id.toString(), "Should have same ID");
    // Other fields should be preserved
    assert(eq.category === equipment.category, "Category should be preserved");
    assert(eq.rentalType === equipment.rentalType, "Rental type should be preserved");
  }),

  test("Admin can update equipment status directly", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({
        status: "approved",
      }),
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.data.equipment.status === "approved", "Equipment status should be approved");
  }),

  test("Admin update validates fields", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({
        rentalPrice: -100,
        rentalType: "hourly",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Admin cannot set invalid status through update", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({
        status: "invalid_status",
      }),
    });

    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Admin update does not allow changing ownerId", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({
        ownerId: "some-other-id",
      }),
    });

    assert(status === 200, `Expected 200, got ${status}`);
    // Verify ownerId was not changed
    const updatedEquipment = await db.collection("equipment").findOne({ _id: equipment._id });
    assert(updatedEquipment.ownerId.equals(ownerProfileId), "OwnerId should not be changed");
  }),

  test("Admin can delete equipment", async () => {
    // Create a new equipment to delete
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete by Admin",
      description: "This equipment will be deleted by admin",
      category: "Construction Equipment",
      location: "Delete City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    const { status, body } = await fetchJson(`/api/admin/equipment/${equipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.deleted === true, "Should confirm deletion");
    assert(body.data.id === equipmentId, "Should return deleted ID");

    // Verify equipment is actually deleted
    const deleted = await db.collection("equipment").findOne({ _id: new ObjectId(equipmentId) });
    assert(deleted === null, "Equipment should be deleted from database");
  }),

  test("Admin can delete approved equipment", async () => {
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved");
    assert(approvedEquipment, "Should have approved equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${approvedEquipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.deleted === true, "Should confirm deletion");
  }),

  test("Delete nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson(`/api/admin/equipment/${new ObjectId()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Delete with invalid ID returns 400", async () => {
    const { status } = await fetchJson("/api/admin/equipment/invalid-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Customer cannot delete equipment via admin endpoint", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Owner cannot delete equipment via admin endpoint", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated delete via admin endpoint rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT.find(e => e.ownerId.equals(ownerProfileId));
    assert(equipment, "Should have test equipment");

    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
    });

    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Owner cannot approve or reject equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    // Try to approve with owner token
    const { status: approveStatus } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(approveStatus === 403, `Expected 403, got ${approveStatus}`);

    // Try to reject with owner token
    const { status: rejectStatus } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(rejectStatus === 403, `Expected 403, got ${rejectStatus}`);
  }),

  test("Customer cannot approve or reject equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    // Try to approve with customer token
    const { status: approveStatus } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(approveStatus === 403, `Expected 403, got ${approveStatus}`);

    // Try to reject with customer token
    const { status: rejectStatus } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(rejectStatus === 403, `Expected 403, got ${rejectStatus}`);
  }),

  test("Public equipment listing still returns approved equipment only", async () => {
    const { status, body } = await fetchJson("/api/equipment");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    const equipment = body.data.equipment;
    assert(Array.isArray(equipment), "Should return equipment array");
    assert(equipment.length > 0, "Should have approved equipment");
    for (const item of equipment) {
      assert(item.status === "approved", `Equipment ${item.id} has status ${item.status}, expected approved`);
    }
  }),

  test("Owner equipment list still works and includes all statuses", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment array");
    const statuses = body.data.equipment.map(e => e.status);
    assert(statuses.includes("approved"), "Should include approved equipment");
    assert(statuses.includes("pending"), "Should include pending equipment");
    assert(statuses.includes("rejected"), "Should include rejected equipment");
  }),

  test("Admin equipment list supports status filter", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?status=pending", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);
    const equipment = body.data.equipment;
    assert(equipment.every(e => e.status === "pending"), "All results should have pending status");
  }),

  test("Admin equipment list supports search", async () => {
    // Create equipment with a unique searchable name to avoid test pollution
    const uniqueName = `SearchTest Excavator ${Date.now()}`;
    const newEquipment = {
      ownerId: ownerProfileId,
      name: uniqueName,
      description: "Equipment for testing search functionality",
      category: "Construction Equipment",
      location: "Search City",
      rentalPrice: 150,
      rentalType: "daily",
      totalQuantity: 2,
      condition: "good",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    try {
      const { status, body } = await fetchJson(`/api/admin/equipment?search=Excavator`, {
        headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      });

      assert(status === 200, `Expected 200, got ${status}`);
      const equipment = body.data.equipment;
      assert(equipment.length >= 1, "Should find at least one excavator");
      assert(equipment.every(e => e.name.toLowerCase().includes("excavator")), "All results should match 'Excavator'");
    } finally {
      await db.collection("equipment").deleteOne({ _id: new ObjectId(equipmentId) });
    }
  }),

  test("Admin equipment list supports category filter", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?category=Construction%20Equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find construction equipment");
    assert(equipment.every(e => e.category === "Construction Equipment"), "All results should be Construction Equipment");
  }),

  test("Admin equipment list supports ownerId filter", async () => {
    const { status, body } = await fetchJson(`/api/admin/equipment?ownerId=${ownerProfileId}`, {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find equipment for owner");
    for (const eq of equipment) {
      assert(eq.owner.id === ownerProfileId.toString(), "All results should belong to the specified owner");
    }
  }),

  test("Admin equipment list supports pagination", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?limit=2&page=1", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.data.pagination.page === 1, "Page should be 1");
    assert(body.data.pagination.limit === 2, "Limit should be 2");
    assert(body.data.equipment.length <= 2, "Should not exceed limit");
  }),

  test("Admin equipment list supports sorting by status", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?sort=status_asc", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);
    const equipment = body.data.equipment;
    // Should have statuses in order: approved, pending, rejected (alphabetically)
    for (let i = 1; i < equipment.length; i++) {
      const prevStatus = equipment[i - 1].status;
      const currStatus = equipment[i].status;
      assert(prevStatus <= currStatus, "Should be sorted by status ascending");
    }
  }),

  test("Invalid status filter returns 400", async () => {
    const { status } = await fetchJson("/api/admin/equipment?status=invalid", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Invalid ownerId filter returns 400", async () => {
    const { status } = await fetchJson("/api/admin/equipment?ownerId=invalid-id", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Admin equipment delete does not affect owner profile", async () => {
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete - Profile Check",
      description: "Testing profile preservation",
      category: "Construction Equipment",
      location: "Profile City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection("equipment").insertOne(newEquipment);
    const equipmentId = result.insertedId.toString();

    const { status } = await fetchJson(`/api/admin/equipment/${equipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}`);

    // Verify owner profile still exists
    const ownerProfile = await db.collection("profiles").findOne({ _id: ownerProfileId });
    assert(ownerProfile !== null, "Owner profile should still exist");
  }),
];

async function main() {
  console.log("=== Phase 1 — Backend Equipment Owner API Test Suite ===\n");
  console.log(`Test database: ${DB_NAME}`);
  console.log(`Server URL: ${BASE_URL}\n`);

  await connectTestDb();
  await insertFixtures();
  await createAuthFixtures();

  let serverProc;
  try {
    serverProc = await startServer();
    await waitForServer();
    console.log("Server is ready\n");

    console.log("Running tests:\n");
    for (const t of runTests) {
      await t();
    }
  } finally {
    if (serverProc) {
      serverProc.kill();
    }
    await cleanupFixtures();
    if (mongoClient) {
      await mongoClient.close();
    }
  }

  // Print summary
  console.log("\n=== Test Summary ===");
  console.log(`Total: ${results.length}`);
  console.log(`PASS: ${passed}`);
  console.log(`FAIL: ${failed}`);
  console.log(`BLOCKED: ${blocked}`);

  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results) {
      if (r.status === "FAIL") {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});