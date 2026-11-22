import { config as dotenvConfig } from "dotenv";
import * as dns from "dns";
import { MongoClient, ObjectId } from "mongodb";
import { spawn } from "child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { handleStripeWebhook } from "../src/modules/equipment/stripe.service.js";
import { reserveCheckoutIntent, releaseIntentReservation } from "../src/modules/equipment/booking.service.js";
import { checkAvailability, createCheckoutIntent } from "../src/modules/equipment/booking.service.js";
import { connectDB as connectAppDB, closeDB as closeAppDB, getClient } from "../src/config/db.js";

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
  process.env.DB_NAME = DB_NAME;
  db = await connectAppDB();
  mongoClient = getClient();
  console.log(`Connected to test database: ${DB_NAME}`);
  // Ensure server process and app DB use same test DB
  process.env.MONGODB_URI = MONGODB_URI;
  process.env.DB_NAME = DB_NAME;
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

  // Store inserted IDs for test reference - use the insertMany result to preserve order
  const insertedIds = Object.values(result.insertedIds);
  console.log("Inserted IDs:", insertedIds.map(id => id.toString()));
  const inserted = await db.collection("equipment").find({ _id: { $in: insertedIds } }).toArray();
  console.log("Found equipment:", inserted.map(e => `${e._id} - ${e.name} - ${e.status}`));
  // Sort by the original fixture order using the insertedIds array
  const idToIndex = new Map(insertedIds.map((id, index) => [id.toString(), index]));
  inserted.sort((a, b) => (idToIndex.get(a._id.toString()) ?? 0) - (idToIndex.get(b._id.toString()) ?? 0));
  global.__TEST_EQUIPMENT = inserted;
  console.log("Sorted equipment:", global.__TEST_EQUIPMENT.map(e => `${e._id} - ${e.name} - ${e.status}`));
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

// --- Tests ---

// Helper functions for favorites tests (create isolated test equipment)
async function createApprovedEquipmentForFavorites(db, ownerProfileId) {
  const equipment = {
    ownerId: ownerProfileId,
    name: `Favorites Test Equipment ${Date.now()}${Math.random()}`,
    description: "Equipment for favorites testing",
    category: "Construction Equipment",
    location: "Test City",
    rentalPrice: 100,
    rentalType: "daily",
    totalQuantity: 5,
    condition: "good",
    status: "approved",
    featured: false,
    inventoryVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await db.collection("equipment").insertOne(equipment);
  return { ...equipment, _id: result.insertedId };
}

async function createPendingEquipmentForFavorites(db, ownerProfileId) {
  const equipment = {
    ownerId: ownerProfileId,
    name: `Pending Favorites Test Equipment ${Date.now()}${Math.random()}`,
    description: "Pending equipment for favorites testing",
    category: "Construction Equipment",
    location: "Test City",
    rentalPrice: 100,
    rentalType: "daily",
    totalQuantity: 5,
    condition: "good",
    status: "pending",
    featured: false,
    inventoryVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await db.collection("equipment").insertOne(equipment);
  return { ...equipment, _id: result.insertedId };
}

async function createRejectedEquipmentForFavorites(db, ownerProfileId) {
  const equipment = {
    ownerId: ownerProfileId,
    name: `Rejected Favorites Test Equipment ${Date.now()}${Math.random()}`,
    description: "Rejected equipment for favorites testing",
    category: "Construction Equipment",
    location: "Test City",
    rentalPrice: 100,
    rentalType: "daily",
    totalQuantity: 5,
    condition: "good",
    status: "rejected",
    featured: false,
    inventoryVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await db.collection("equipment").insertOne(equipment);
  return { ...equipment, _id: result.insertedId };
}

async function createBookingForCustomer(db, customerId, equipmentId, ownerId) {
  const booking = {
    equipmentId,
    ownerId,
    userId: customerId,
    startDate: new Date("2026-12-01"),
    endDate: new Date("2026-12-07"),
    quantity: 1,
    contactPhone: "+1-555-0100",
    deliveryAddress: "123 Test St, Test City",
    notes: "Test booking",
    bookingStatus: "confirmed",
    paymentStatus: "paid",
    totalPrice: 700,
    bookingDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await db.collection("bookings").insertOne(booking);
  return { ...booking, _id: result.insertedId };
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
    const { status, body } = await fetchJson("/api/equipment?search=New York");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one in New York");
    assert(equipment.every((e) => e.location.toLowerCase().includes("new york")), "All results should match 'New York'");
  }),

  test("Search by category works", async () => {
    const { status, body } = await fetchJson("/api/equipment?search=Construction");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one construction equipment");
    assert(equipment.every((e) => e.category.toLowerCase().includes("construction")), "All results should match 'Construction'");
  }),

  test("Category filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?category=Construction Equipment");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one construction equipment");
    assert(equipment.every((e) => e.category === "Construction Equipment"), "All results should be Construction Equipment");
  }),

  test("Rental type filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?rentalType=daily");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one daily rental");
    assert(equipment.every((e) => e.rentalType === "daily"), "All results should be daily rental type");
  }),

  test("Price range filter works", async () => {
    const { status, body } = await fetchJson("/api/equipment?minPrice=100&maxPrice=200");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one in price range");
    assert(equipment.every((e) => e.rentalPrice >= 100 && e.rentalPrice <= 200), "All results should be in price range");
  }),

  test("Availability filter - available works", async () => {
    const { status, body } = await fetchJson("/api/equipment?availability=available");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one available");
    assert(equipment.every((e) => e.availableQuantity > 0), "All results should be available");
  }),

  test("Availability filter - unavailable works", async () => {
    const { status, body } = await fetchJson("/api/equipment?availability=unavailable");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 1, "Should find at least one unavailable");
    assert(equipment.every((e) => e.availableQuantity === 0), "All results should be unavailable");
  }),

  test("Sort price low to high works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=price_asc");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 2, "Should have at least 2 items");
    for (let i = 1; i < equipment.length; i++) {
      assert(equipment[i].rentalPrice >= equipment[i - 1].rentalPrice, "Should be sorted by price ascending");
    }
  }),

  test("Sort price high to low works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=price_desc");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 2, "Should have at least 2 items");
    for (let i = 1; i < equipment.length; i++) {
      assert(equipment[i].rentalPrice <= equipment[i - 1].rentalPrice, "Should be sorted by price descending");
    }
  }),

  test("Sort recently added works", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=newest");
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 2, "Should have at least 2 items");
    for (let i = 1; i < equipment.length; i++) {
      assert(new Date(equipment[i].createdAt).getTime() <= new Date(equipment[i - 1].createdAt).getTime(), "Should be sorted by createdAt descending");
    }
  }),

  test("Pagination returns correct metadata", async () => {
    const { status, body } = await fetchJson("/api/equipment?page=1&limit=2");
    assert(status === 200);
    assert(body.data.pagination, "Should have pagination");
    assert(body.data.pagination.page === 1, "Page should be 1");
    assert(body.data.pagination.limit === 2, "Limit should be 2");
    assert(body.data.pagination.total > 0, "Total should be > 0");
    assert(body.data.pagination.totalPages > 0, "Total pages should be > 0");
    assert(body.data.pagination.hasNext === true, "Should have next page");
    assert(body.data.pagination.hasPrev === false, "Should not have prev page");
  }),

  test("Pagination page 2 does not duplicate page 1", async () => {
    const { status: status1, body: body1 } = await fetchJson("/api/equipment?page=1&limit=2");
    const { status: status2, body: body2 } = await fetchJson("/api/equipment?page=2&limit=2");
    assert(status1 === 200 && status2 === 200);
    const ids1 = body1.data.equipment.map(e => e.id);
    const ids2 = body2.data.equipment.map(e => e.id);
    for (const id of ids1) {
      assert(!ids2.includes(id), `Duplicate ID ${id} on page 2`);
    }
  }),

  test("Invalid sort parameter returns 400", async () => {
    const { status, body } = await fetchJson("/api/equipment?sort=invalid");
    assert(status === 400);
    assert(body.success === false);
    assert(body.error.code === "INVALID_SORT");
  }),

  test("Invalid rental type returns 400", async () => {
    const { status, body } = await fetchJson("/api/equipment?rentalType=invalid");
    assert(status === 400);
    assert(body.success === false);
    assert(body.error.code === "INVALID_RENTAL_TYPE");
  }),

  test("Invalid availability returns 400", async () => {
    const { status, body } = await fetchJson("/api/equipment?availability=invalid");
    assert(status === 400);
    assert(body.success === false);
    assert(body.error.code === "INVALID_AVAILABILITY");
  }),

  test("Negative price handled safely", async () => {
    const { status, body } = await fetchJson("/api/equipment?minPrice=-100");
    assert(status === 200);
  }),

  test("Non-numeric page handled safely", async () => {
    const { status, body } = await fetchJson("/api/equipment?page=abc");
    assert(status === 200);
  }),

  test("Details endpoint rejects unauthenticated request", async () => {
    const { status } = await fetchJson("/api/equipment/invalid-id");
    assert(status === 401);
  }),

  test("Details endpoint returns correct equipment for authenticated user", async () => {
    const { status, body } = await fetchJson(
      `/api/equipment/${global.__TEST_EQUIPMENT[0]._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.id === global.__TEST_EQUIPMENT[0]._id.toString(), "Should return correct equipment");
  }),

  test("Invalid ID returns 404", async () => {
    const { status } = await fetchJson(
      `/api/equipment/invalid-id`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 404);
  }),

  test("Nonexistent ObjectId returns 404", async () => {
    const { status } = await fetchJson(
      `/api/equipment/507f1f77bcf86cd799439011`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 404);
  }),

  test("Customer cannot access pending equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending")
    assert(pendingEquipment, "Should have pending equipment fixture")

    const { status } = await fetchJson(
      `/api/equipment/${pendingEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 404, `Customer should not access pending equipment, got ${status}`);
  }),

  test("Customer cannot access rejected equipment", async () => {
    const rejectedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "rejected")
    assert(rejectedEquipment, "Should have rejected equipment fixture")

    const { status } = await fetchJson(
      `/api/equipment/${rejectedEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 404, `Customer should not access rejected equipment, got ${status}`);
  }),

  test("Customer can access approved equipment", async () => {
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved")
    assert(approvedEquipment, "Should have approved equipment fixture")

    const { status, body } = await fetchJson(
      `/api/equipment/${approvedEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status === 200, `Customer should access approved equipment, got ${status}`);
    assert(body.success === true, "Response should be successful");
  }),

  test("Owner can access their own pending equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending")
    assert(pendingEquipment, "Should have pending equipment fixture")

    const { status, body } = await fetchJson(
      `/api/equipment/${pendingEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    );
    assert(status === 200, `Owner should access own pending equipment, got ${status}`);
    assert(body.success === true, "Response should be successful");
  }),

  test("Owner can access their own rejected equipment", async () => {
    const rejectedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "rejected")
    assert(rejectedEquipment, "Should have rejected equipment fixture")

    const { status, body } = await fetchJson(
      `/api/equipment/${rejectedEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    );
    assert(status === 200, `Owner should access own rejected equipment, got ${status}`);
    assert(body.success === true, "Response should be successful");
  }),

  test("Owner cannot access another owner's equipment", async () => {
    // Create another owner and their equipment
    const otherOwnerProfile = {
      betterAuthUserId: "test-other-owner-1",
      name: "Other Owner",
      email: "other-owner@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.collection("profiles").insertOne(otherOwnerProfile)
    const otherOwnerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-other-owner-1" })

    // Create JWT for other owner
    const keyPair = await generateKeyPair("EdDSA")
    const jwk = await exportJWK(keyPair.publicKey)
    const kid = "test-key-" + Date.now()
    await db.collection("jwks").insertOne({
      _id: kid,
      publicKey: JSON.stringify(jwk),
      alg: "EdDSA",
    })

    const otherOwnerJwt = await new SignJWT({
      sub: "test-other-owner-1",
      role: "owner",
      roleVersion: 0,
      profileImage: null,
    })
      .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
      .setIssuer(BETTER_AUTH_URL)
      .setAudience(BETTER_AUTH_URL)
      .setExpirationTime("1h")
      .sign(keyPair.privateKey)

    // Other owner creates equipment
    const otherEquipment = {
      ownerId: otherOwnerProfileDoc._id,
      name: "Other Owner's Equipment",
      description: "Equipment belonging to another owner",
      category: "Construction Equipment",
      location: "Boston, MA",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      image: "https://example.com/other.jpg",
      rentalTerms: "Terms",
      status: "approved",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const equipResult = await db.collection("equipment").insertOne(otherEquipment)
    const otherEquipmentId = equipResult.insertedId

    // First owner tries to access other owner's equipment - should get 404
    const { status } = await fetchJson(
      `/api/equipment/${otherEquipmentId}`,
      { headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` } }
    )
    assert(status === 404, `Owner should not access another owner's equipment, got ${status}`)

    // Cleanup
    await db.collection("equipment").deleteOne({ _id: otherEquipmentId })
    await db.collection("profiles").deleteOne({ _id: otherOwnerProfileDoc._id })
    await db.collection("jwks").deleteOne({ _id: kid })
  }),

  test("Admin can access all equipment statuses", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending")
    const rejectedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "rejected")
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved")

    assert(pendingEquipment && rejectedEquipment && approvedEquipment, "Should have all equipment statuses")

    for (const equipment of [pendingEquipment, rejectedEquipment, approvedEquipment]) {
      const { status } = await fetchJson(
        `/api/equipment/${equipment._id}`,
        { headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` } }
      )
      assert(status === 200, `Admin should access ${equipment.status} equipment, got ${status}`)
    }
  }),

  test("Existing auth/profile endpoints continue working", async () => {
    const { status } = await fetchJson("/api/profile", {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ name: "Updated Name" }),
    });
    assert(status === 200, `Expected 200, got ${status}`);
  }),

  test("Owner can create equipment with all required fields", async () => {
    const newEquipment = {
      name: "New Test Equipment",
      description: "Test description",
      category: "Construction Equipment",
      location: "Test City",
      rentalPrice: 100,
      rentalType: "daily",
      totalQuantity: 2,
      condition: "good",
      image: "https://example.com/test.jpg",
      rentalTerms: "Test terms",
      status: "pending",
    };

    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify(newEquipment),
    });

    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment object");
    assert(body.data.equipment.name === newEquipment.name, "Name should match");
    assert(body.data.equipment.status === "pending", "New equipment should be pending");
    assert(body.data.equipment.ownerId === ownerProfileId.toString(), "Owner ID should match");
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
  }),

  test("Owner create equipment validates rental type", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: 100,
        rentalType: "invalid",
        totalQuantity: 1,
        condition: "good",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment validates category", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Invalid Category",
        location: "Test",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment validates price and quantity", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: -10,
        rentalType: "daily",
        totalQuantity: 0,
        condition: "good",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment validates condition", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "invalid",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment validates image URL", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        image: "not-a-url",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment rejects client-supplied status", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        status: "approved",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner create equipment rejects client-supplied ownerId", async () => {
    const { status, body } = await fetchJson("/api/equipment", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({
        name: "Test",
        description: "Test",
        category: "Construction Equipment",
        location: "Test",
        rentalPrice: 100,
        rentalType: "daily",
        totalQuantity: 1,
        condition: "good",
        ownerId: "507f1f77bcf86cd799439011",
      }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner can list their equipment with all statuses", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment array");
    assert(Array.isArray(body.data.equipment), "Equipment should be an array");
    assert(body.data.equipment.length >= 6, "Should have at least 6 equipment items (fixtures + created)");
    console.log(`    Found ${body.data.equipment.length} equipment items for owner`);
  }),

  test("Owner equipment list sorted newest first", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 200);
    const equipment = body.data.equipment;
    assert(equipment.length >= 2);
    for (let i = 1; i < equipment.length; i++) {
      const prev = new Date(equipment[i - 1].createdAt).getTime();
      const curr = new Date(equipment[i].createdAt).getTime();
      assert(prev >= curr, "Equipment should be sorted newest first");
    }
  }),

  test("Owner equipment list supports pagination", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me?page=1&limit=2", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 200);
    assert(body.data.pagination, "Should have pagination");
    assert(body.data.pagination.page === 1);
    assert(body.data.pagination.limit === 2);
    assert(body.data.pagination.hasNext === true);
  }),

  test("Customer cannot access owner equipment list", async () => {
    const { status } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated request rejected for owner equipment list", async () => {
    const { status } = await fetchJson("/api/equipment/owner/me");
    assert(status === 401);
  }),

  test("Owner can update their equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "Updated Name", rentalPrice: 200 }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.name === "Updated Name", "Name should be updated");
    assert(body.data.equipment.rentalPrice === 200, "Price should be updated");
  }),

  test("Owner can partially update equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ description: "Updated description only" }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true);
    assert(body.data.equipment.description === "Updated description only");
  }),

  test("Owner update validates fields", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ rentalPrice: -10, rentalType: "invalid" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner cannot update another owner's equipment", async () => {
    const otherOwnerProfile = {
      betterAuthUserId: "test-other-owner-1",
      name: "Other Owner",
      email: "other-owner@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherOwnerProfile);
    const otherOwnerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-other-owner-1" });

    const otherEquipment = {
      ownerId: otherOwnerProfileDoc._id,
      name: "Other Equipment",
      description: "Other owner's equipment",
      category: "Construction Equipment",
      location: "Boston, MA",
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
    const equipResult = await db.collection("equipment").insertOne(otherEquipment);
    const otherEquipmentId = equipResult.insertedId;

    const { status } = await fetchJson(`/api/equipment/${otherEquipmentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "Hacked Name" }),
    });
    assert(status === 403, `Expected 403, got ${status}`);

    await db.collection("equipment").deleteOne({ _id: otherEquipmentId });
    await db.collection("profiles").deleteOne({ _id: otherOwnerProfileDoc._id });
  }),

  test("Owner cannot change status through PUT", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ status: "approved" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Owner cannot change ownerId through PUT", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ ownerId: "507f1f77bcf86cd799439011" }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Update nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson("/api/equipment/507f1f77bcf86cd799439011", {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "Test" }),
    });
    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Update with invalid ID returns 400", async () => {
    const { status } = await fetchJson("/api/equipment/invalid-id", {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ name: "Test" }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Customer cannot update equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ name: "Test" }),
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated update rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Test" }),
    });
    assert(status === 401);
  }),

  test("Owner can delete their equipment", async () => {
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete",
      description: "Testing delete",
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
    assert(body.success === true);
    assert(body.data.deleted === true);

    const deleted = await db.collection("equipment").findOne({ _id: new ObjectId(equipmentId) });
    assert(deleted === null, "Equipment should be deleted from database");
  }),

  test("Owner cannot delete another owner's equipment", async () => {
    const otherOwnerProfile = {
      betterAuthUserId: "test-other-owner-2",
      name: "Other Owner 2",
      email: "other2@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherOwnerProfile);
    const otherOwnerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-other-owner-2" });

    const otherEquipment = {
      ownerId: otherOwnerProfileDoc._id,
      name: "Other Equipment 2",
      description: "Other owner's equipment 2",
      category: "Construction Equipment",
      location: "Seattle, WA",
      rentalPrice: 150,
      rentalType: "daily",
      totalQuantity: 1,
      condition: "good",
      status: "pending",
      featured: false,
      inventoryVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const equipResult = await db.collection("equipment").insertOne(otherEquipment);
    const otherEquipmentId = equipResult.insertedId.toString();

    const { status } = await fetchJson(`/api/equipment/${otherEquipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);

    await db.collection("equipment").deleteOne({ _id: otherOwnerProfileDoc._id });
    await db.collection("profiles").deleteOne({ _id: otherOwnerProfileDoc._id });
  }),

  test("Delete nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson("/api/equipment/507f1f77bcf86cd799439011", {
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
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated delete rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/equipment/${equipment._id}`, {
      method: "DELETE",
    });
    assert(status === 401);
  }),

  test("Delete does not affect unrelated data", async () => {
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete - Unrelated Check",
      description: "Testing unrelated data",
      category: "Construction Equipment",
      location: "Unrelated City",
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

    const { status } = await fetchJson(`/api/equipment/${equipmentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 200);

    const otherEquipment = await db.collection("equipment").findOne({ _id: global.__TEST_EQUIPMENT[0]._id });
    assert(otherEquipment !== null, "Other equipment should still exist");
  }),

  test("Admin can retrieve the user list", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.users, "Should have users array");
    assert(Array.isArray(body.data.users), "Users should be an array");
    assert(body.data.users.length >= 3, "Should have at least 3 users (fixtures)");
  }),

  test("User list includes name, email, role and registration date", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200);
    assert(body.success === true);
    assert(body.data.users.length >= 3);
    for (const user of body.data.users) {
      assert(user.name, "User should have name");
      assert(user.email, "User should have email");
      assert(user.role, "User should have role");
      assert(user.createdAt, "User should have createdAt");
    }
  }),

  test("Sensitive authentication fields are not exposed in user list", async () => {
    const { status, body } = await fetchJson("/api/admin/users", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200);
    for (const user of body.data.users) {
      assert(user.passwordHash === undefined, "Should not expose passwordHash");
      assert(user.betterAuthUserId === undefined, "Should not expose betterAuthUserId");
    }
  }),

  test("Admin can change Customer to Owner", async () => {
    const targetUser = global.__TEST_CUSTOMER_JWT; // This is a JWT, not the user ID. We need to get the customer profile ID.
    // The customer profile ID is customerProfileId.
    const { status, body } = await fetchJson(`/api/admin/users/${customerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.user.role === "owner", "User role should be owner");
  }),

  test("Admin can change Owner to Customer", async () => {
    const { status, body } = await fetchJson(`/api/admin/users/${ownerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "customer" }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.user.role === "customer", "User role should be customer");
  }),

  test("Admin can change a user's role to Admin", async () => {
    const { status, body } = await fetchJson(`/api/admin/users/${customerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "admin" }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.user.role === "admin", "User role should be admin");
  }),

  test("Invalid roles are rejected", async () => {
    const { status, body } = await fetchJson(`/api/admin/users/${customerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "invalid" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Invalid IDs are rejected", async () => {
    const { status, body } = await fetchJson("/api/admin/users/invalid-id/role", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.success === false);
    assert(body.error.code === "INVALID_ID");
  }),

  test("Nonexistent users are handled correctly", async () => {
    const { status, body } = await fetchJson("/api/admin/users/507f1f77bcf86cd799439011/role", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 404, `Expected 404, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "USER_NOT_FOUND");
  }),

  test("Unauthenticated requests are rejected for admin users list", async () => {
    const { status } = await fetchJson("/api/admin/users");
    assert(status === 401);
  }),

  test("Unauthenticated requests are rejected for admin role change", async () => {
    const { status } = await fetchJson("/api/admin/users/507f1f77bcf86cd799439011/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 401);
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
    const { status, body } = await fetchJson(`/api/admin/users/${customerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "owner" }),
    });
    assert(status === 200);
    const roleVersionAfter = body.data.user.roleVersion;

    const { status: status2, body: body2 } = await fetchJson(`/api/admin/users/${customerProfileId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ role: "customer" }),
    });
    assert(status2 === 200);
    const roleVersionAfter2 = body2.data.user.roleVersion;

    assert(roleVersionAfter2 > roleVersionAfter, "roleVersion should increment after role change");
  }),

  test("JWT with old roleVersion cannot continue using old authorization", async () => {
    const keyPair = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(keyPair.publicKey);
    const kid = "test-key-old-" + Date.now();
    await db.collection("jwks").insertOne({
      _id: kid,
      publicKey: JSON.stringify(jwk),
      alg: "EdDSA",
    });

    const oldJwt = await new SignJWT({
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

    const { status } = await fetchJson("/api/profile", {
      headers: { Authorization: `Bearer ${oldJwt}` },
    });
    assert(status === 401, `Expected 401 for old roleVersion JWT, got ${status}`);

    await db.collection("jwks").deleteOne({ _id: kid });
  }),

  test("Admin can retrieve all equipment across all statuses", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment, "Should have equipment array");
    assert(Array.isArray(body.data.equipment), "Equipment should be an array");
    assert(body.data.equipment.length >= 6, "Should have at least 6 equipment items");
    const statuses = body.data.equipment.map(e => e.status).sort();
    assert(statuses.includes("pending"), "Should include pending");
    assert(statuses.includes("approved"), "Should include approved");
    assert(statuses.includes("rejected"), "Should include rejected");
  }),

  test("Admin equipment list includes owner information", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200);
    assert(body.success === true);
    assert(body.data.equipment.length >= 1);
    for (const equip of body.data.equipment) {
      assert(equip.owner, "Equipment should have owner info");
      assert(equip.owner.name, "Owner should have name");
      assert(equip.owner.email, "Owner should have email");
    }
  }),

  test("Admin equipment list includes all statuses: pending, approved, rejected", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200);
    const equipment = body.data.equipment;
    const statuses = equipment.map(e => e.status).sort();
    assert(statuses.includes("pending"), "Should include pending");
    assert(statuses.includes("approved"), "Should include approved");
    assert(statuses.includes("rejected"), "Should include rejected");
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
    assert(status === 401);
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
    assert(body.data.equipment.status === "approved", "Equipment should be approved");
  }),

  test("Admin can reject pending equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.status === "rejected", "Equipment should be rejected");
  }),

  test("Admin cannot approve nonexistent equipment", async () => {
    const { status } = await fetchJson("/api/admin/equipment/507f1f77bcf86cd799439011/approve", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Admin cannot reject nonexistent equipment", async () => {
    const { status } = await fetchJson("/api/admin/equipment/507f1f77bcf86cd799439011/reject", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 404, `Expected 404, got ${status}`);
  }),

  test("Invalid equipment ID returns 400 for approve", async () => {
    const { status } = await fetchJson("/api/admin/equipment/invalid-id/approve", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Invalid equipment ID returns 400 for reject", async () => {
    const { status } = await fetchJson("/api/admin/equipment/invalid-id/reject", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Approved equipment cannot be approved again", async () => {
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved");
    assert(approvedEquipment, "Should have approved equipment fixture");

    const { status } = await fetchJson(`/api/admin/equipment/${approvedEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Rejected equipment cannot be rejected again", async () => {
    const rejectedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "rejected");
    assert(rejectedEquipment, "Should have rejected equipment fixture");

    const { status } = await fetchJson(`/api/admin/equipment/${rejectedEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Admin can update equipment", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ name: "Admin Updated", rentalPrice: 300 }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.name === "Admin Updated", "Name should be updated");
    assert(body.data.equipment.rentalPrice === 300, "Price should be updated");
  }),

  test("Admin can update equipment status directly", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status, body } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ status: "approved" }),
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.status === "approved", "Equipment should be approved");
  }),

  test("Admin update validates fields", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ rentalPrice: -10, rentalType: "invalid" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Admin cannot set invalid status through update", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ status: "invalid" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Admin update does not allow changing ownerId", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status, body } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ ownerId: "507f1f77bcf86cd799439011" }),
    });
    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false);
    assert(body.error.code === "VALIDATION_ERROR");
  }),

  test("Admin can delete equipment", async () => {
    const newEquipment = {
      ownerId: ownerProfileId,
      name: "Equipment to Delete - Admin",
      description: "Testing admin delete",
      category: "Construction Equipment",
      location: "Admin City",
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

    const deleted = await db.collection("equipment").findOne({ _id: new ObjectId(equipmentId) });
    assert(deleted === null, "Equipment should be deleted from database");
  }),

  test("Admin can delete approved equipment", async () => {
    const approvedEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "approved");
    assert(approvedEquipment, "Should have approved equipment fixture");

    const { status } = await fetchJson(`/api/admin/equipment/${approvedEquipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);

    const deleted = await db.collection("equipment").findOne({ _id: approvedEquipment._id });
    assert(deleted === null, "Approved equipment should be deleted from database");
  }),

  test("Delete nonexistent equipment returns 404", async () => {
    const { status } = await fetchJson("/api/admin/equipment/507f1f77bcf86cd799439011", {
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
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Owner cannot delete equipment via admin endpoint", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Unauthenticated delete via admin endpoint rejected", async () => {
    const equipment = global.__TEST_EQUIPMENT[0];
    const { status } = await fetchJson(`/api/admin/equipment/${equipment._id}`, {
      method: "DELETE",
    });
    assert(status === 401);
  }),

  test("Owner cannot approve or reject equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status: status1 } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status1 === 403, `Expected 403 for owner approve, got ${status1}`);

    const { status: status2 } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status2 === 403, `Expected 403 for owner reject, got ${status2}`);
  }),

  test("Customer cannot approve or reject equipment", async () => {
    const pendingEquipment = global.__TEST_EQUIPMENT.find(e => e.status === "pending");
    assert(pendingEquipment, "Should have pending equipment fixture");

    const { status: status1 } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/approve`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status1 === 403, `Expected 403 for customer approve, got ${status1}`);

    const { status: status2 } = await fetchJson(`/api/admin/equipment/${pendingEquipment._id}/reject`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(status2 === 403, `Expected 403 for customer reject, got ${status2}`);
  }),

  test("Public equipment listing still returns approved equipment only", async () => {
    const { status, body } = await fetchJson("/api/equipment");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.equipment.every(e => e.status === "approved"), "Public listing should only have approved equipment");
  }),

  test("Owner equipment list still works and includes all statuses", async () => {
    const { status, body } = await fetchJson("/api/equipment/owner/me", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.success === true, "Response should be successful");
    const equipment = body.data.equipment;
    const statuses = equipment.map(e => e.status);
    assert(statuses.includes("pending"), "Owner list should include pending");
    assert(statuses.includes("approved"), "Owner list should include approved");
    assert(statuses.includes("rejected"), "Owner list should include rejected");
  }),

  test("Admin equipment list supports status filter", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?status=pending", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.data.equipment.every(e => e.status === "pending"), "All should be pending");
  }),

  test("Admin equipment list supports search", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?search=Excavator", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.data.equipment.length >= 1, "Should find excavator");
  }),

  test("Admin equipment list supports category filter", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?category=Construction Equipment", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.data.equipment.every(e => e.category === "Construction Equipment"), "All should be Construction Equipment");
  }),

  test("Admin equipment list supports ownerId filter", async () => {
    const { status, body } = await fetchJson(`/api/admin/equipment?ownerId=${ownerProfileId}`, {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.data.equipment.every(e => e.ownerId === ownerProfileId.toString()), "All should belong to test owner");
  }),

  test("Admin equipment list supports pagination", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?page=1&limit=2", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200);
    assert(body.data.pagination, "Should have pagination");
    assert(body.data.pagination.page === 1, "Page should be 1");
    assert(body.data.pagination.limit === 2, "Limit should be 2");
    assert(body.data.pagination.hasNext === true, "Should have next page");
  }),

  test("Admin equipment list supports sorting by status", async () => {
    const { status, body } = await fetchJson("/api/admin/equipment?sort=status_asc", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 200, `Expected 200, got ${status}`);
    const equipment = body.data.equipment;
    assert(equipment.length >= 2, "Should have at least 2 items");
    for (let i = 1; i < equipment.length; i++) {
      assert(equipment[i].status >= equipment[i - 1].status, "Should be sorted by status ascending");
    }
  }),

  test("Invalid status filter returns 400", async () => {
    const { status } = await fetchJson("/api/admin/equipment?status=invalid", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 400, `Expected 400, got ${status}`);
  }),

  test("Invalid ownerId filter returns 400", async () => {
    const { status } = await fetchJson("/api/admin/equipment?ownerId=invalid", {
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

  // ========== FAVORITES API TESTS ==========
  test("Customer can add a favorite", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    const { status, body } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.favorite, "Should have favorite object");
    assert(body.data.favorite.equipmentId === approvedEquipment._id.toString(), "Should have correct equipmentId");
    assert(body.data.favorite.userId, "Should have userId");
    assert(body.data.favorite.id, "Should have favorite ID");
  }),

  test("Duplicate favorite is rejected", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    // First add
    await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    // Try to add again
    const { status, body } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    assert(status === 409, `Expected 409, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false, "Response should be error");
    assert(body.error.code === "DUPLICATE_FAVORITE", "Should have duplicate favorite error code");
  }),

  test("Customer can list their own favorites", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    // Add a favorite first
    await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    const { status, body } = await fetchJson("/api/favorites", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.favorites, "Should have favorites array");
    assert(Array.isArray(body.data.favorites), "Favorites should be an array");
    assert(body.data.favorites.length >= 1, "Should have at least one favorite");
    assert(body.data.favorites.some((f) => f.equipmentId === approvedEquipment._id.toString()), "Should include the added favorite");
    assert(body.data.pagination, "Should have pagination");
  }),

  test("Customer can remove their own favorite", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    // Add a favorite first
    const addResponse = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });
    const favoriteId = addResponse.body.data.favorite.id;

    // Remove the favorite
    const { status, body } = await fetchJson(`/api/favorites/${favoriteId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.deleted === true, "Should confirm deletion");
    assert(body.data.id === favoriteId, "Should return deleted ID");

    // Verify it's removed from list
    const { status: listStatus, body: listBody } = await fetchJson("/api/favorites", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });
    assert(listStatus === 200);
    assert(!listBody.data.favorites.some((f) => f.id === favoriteId), "Favorite should be removed from list");
  }),

  test("Customer cannot remove another Customer's favorite", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    // Create another customer
    const otherCustomerProfile = {
      betterAuthUserId: "test-customer-2",
      name: "Other Customer",
      email: "customer2@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherCustomerProfile);
    const otherCustomerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-customer-2" });

    // Create JWT for other customer
    const keyPair = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(keyPair.publicKey);
    const kid = "test-key-" + Date.now();
    await db.collection("jwks").insertOne({
      _id: kid,
      publicKey: JSON.stringify(jwk),
      alg: "EdDSA",
    });

    const otherCustomerJwt = await new SignJWT({
      sub: "test-customer-2",
      role: "customer",
      roleVersion: 0,
      profileImage: null,
    })
      .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
      .setIssuer(BETTER_AUTH_URL)
      .setAudience(BETTER_AUTH_URL)
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);

    // Other customer adds a favorite
    const addResponse = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${otherCustomerJwt}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });
    const favoriteId = addResponse.body.data.favorite.id;

    // First customer tries to remove other customer's favorite
    const { status } = await fetchJson(`/api/favorites/${favoriteId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 403, `Expected 403, got ${status}`);

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: otherCustomerProfileDoc._id });
    await db.collection("jwks").deleteOne({ _id: kid });
  }),

  test("Customer cannot favorite pending equipment", async () => {
    const pendingEquipment = await createPendingEquipmentForFavorites(db, ownerProfileId);

    const { status, body } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: pendingEquipment._id.toString() }),
    });

    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false, "Response should be error");
    assert(body.error.code === "INVALID_STATUS", "Should have invalid status error code");
  }),

  test("Customer cannot favorite rejected equipment", async () => {
    const rejectedEquipment = await createRejectedEquipmentForFavorites(db, ownerProfileId);

    const { status, body } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: rejectedEquipment._id.toString() }),
    });

    assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === false, "Response should be error");
    assert(body.error.code === "INVALID_STATUS", "Should have invalid status error code");
  }),

  test("Unauthenticated requests are rejected for favorites", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    const { status } = await fetchJson("/api/favorites", {
      method: "POST",
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Owner cannot use Customer Favorites APIs", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    const { status } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Admin cannot use Customer Favorites APIs", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    const { status } = await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Equipment details includes isFavorited field for customers", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);

    // First, check without favorite
    const { status: status1, body: body1 } = await fetchJson(
      `/api/equipment/${approvedEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status1 === 200, `Expected 200, got ${status1}`);
    assert(body1.data.equipment.isFavorited === false, "Should not be favorited initially");

    // Add favorite
    await fetchJson("/api/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
      body: JSON.stringify({ equipmentId: approvedEquipment._id.toString() }),
    });

    // Check again
    const { status: status2, body: body2 } = await fetchJson(
      `/api/equipment/${approvedEquipment._id}`,
      { headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` } }
    );
    assert(status2 === 200, `Expected 200, got ${status2}`);
    assert(body2.data.equipment.isFavorited === true, "Should be favorited after adding");
  }),

  // ========== CUSTOMER RENTALS API TESTS ==========
  test("Authenticated Customer can retrieve their own rentals", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const booking = await createBookingForCustomer(db, customerProfileId, approvedEquipment._id, ownerProfileId);

    const { status, body } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.rentals, "Should have rentals array");
    assert(Array.isArray(body.data.rentals), "Rentals should be an array");
    assert(body.data.rentals.length >= 1, "Should have at least one rental");
    const rental = body.data.rentals.find((r) => r.id === booking._id.toString());
    assert(rental, "Should include the created rental");
    assert(rental.equipmentId === approvedEquipment._id.toString(), "Should have correct equipmentId");
    assert(rental.equipment, "Should have equipment details");
    assert(rental.equipment.name === approvedEquipment.name, "Should have equipment name");
    assert(rental.bookingStatus, "Should have bookingStatus");
    assert(rental.paymentStatus, "Should have paymentStatus");
    assert(rental.totalPrice === 700, "Should have totalPrice");
    assert(rental.startDate, "Should have startDate");
    assert(rental.endDate, "Should have endDate");
    assert(rental.bookingDate, "Should have bookingDate");
    assert(body.data.pagination, "Should have pagination");
  }),

  test("Customer cannot retrieve another Customer's rentals", async () => {
    // Create another customer
    const otherCustomerProfile = {
      betterAuthUserId: "test-customer-2",
      name: "Other Customer",
      email: "customer2@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("profiles").insertOne(otherCustomerProfile);
    const otherCustomerProfileDoc = await db.collection("profiles").findOne({ betterAuthUserId: "test-customer-2" });

    // Create JWT for other customer
    const keyPair = await generateKeyPair("EdDSA");
    const jwk = await exportJWK(keyPair.publicKey);
    const kid = "test-key-" + Date.now();
    await db.collection("jwks").insertOne({
      _id: kid,
      publicKey: JSON.stringify(jwk),
      alg: "EdDSA",
    });

    const otherCustomerJwt = await new SignJWT({
      sub: "test-customer-2",
      role: "customer",
      roleVersion: 0,
      profileImage: null,
    })
      .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
      .setIssuer(BETTER_AUTH_URL)
      .setAudience(BETTER_AUTH_URL)
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);

    // Create booking for other customer
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await createBookingForCustomer(db, otherCustomerProfileDoc._id, approvedEquipment._id, ownerProfileId);

    // First customer tries to access rentals - should only see their own (empty)
    const { status, body } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.rentals.length === 0, "First customer should not see other customer's rentals");

    // Cleanup
    await db.collection("profiles").deleteOne({ _id: otherCustomerProfileDoc._id });
    await db.collection("jwks").deleteOne({ _id: kid });
  }),

  test("Unauthenticated request is rejected for rentals", async () => {
    const { status } = await fetchJson("/api/rentals");
    assert(status === 401, `Expected 401, got ${status}`);
  }),

  test("Owner cannot use Customer Rentals API", async () => {
    const { status } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_OWNER_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Admin cannot use Customer Rentals API", async () => {
    const { status } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_ADMIN_JWT}` },
    });
    assert(status === 403, `Expected 403, got ${status}`);
  }),

  test("Empty rentals list returns valid empty response", async () => {
    // Customer with no bookings
    const { status, body } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.rentals, "Should have rentals array");
    assert(Array.isArray(body.data.rentals), "Rentals should be an array");
    assert(body.data.rentals.length === 0, "Should be empty array");
    assert(body.data.pagination, "Should have pagination");
    assert(body.data.pagination.total === 0, "Total should be 0");
  }),

  test("Invalid pagination parameters are handled safely", async () => {
    const { status, body } = await fetchJson("/api/rentals?page=invalid&limit=invalid", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    // Should not crash, should return valid response with defaults
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.success === true, "Response should be successful");
    assert(body.data.rentals, "Should have rentals array");
    assert(body.data.pagination, "Should have pagination");
  }),

  test("Rental includes correct equipment and booking fields", async () => {
    const approvedEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const booking = await createBookingForCustomer(db, customerProfileId, approvedEquipment._id, ownerProfileId);

    const { status, body } = await fetchJson("/api/rentals", {
      headers: { Authorization: `Bearer ${global.__TEST_CUSTOMER_JWT}` },
    });

    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    const rental = body.data.rentals.find((r) => r.id === booking._id.toString());
    assert(rental, "Should find the rental");

    // Verify all required fields for the 7-column table
    assert(rental.equipmentId, "Should have equipmentId");
    assert(rental.equipment?.name, "Should have equipment name");
    assert(rental.startDate, "Should have startDate (Rental Start Date)");
    assert(rental.endDate, "Should have endDate (Rental End Date)");
    assert(rental.bookingDate, "Should have bookingDate (Booking Date)");
    assert(typeof rental.totalPrice === "number", "Should have totalPrice (Total Amount)");
    assert(rental.paymentStatus, "Should have paymentStatus (Payment Status)");
    assert(rental.bookingStatus, "Should have bookingStatus (Booking Status)");

    // Equipment details
    assert(rental.equipment, "Should have equipment object");
    assert(rental.equipment.name === approvedEquipment.name, "Equipment name should match");
    assert(rental.equipment.category, "Should have equipment category");
    assert(typeof rental.equipment.rentalPrice === "number", "Should have equipment rentalPrice");
  }),

  // ========== ACCEPTANCE TESTS FOR PHASE 4.1 FIXES ==========
  test("Processing intent remains counted until booking is created (inventory gap race)", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-02-01", "2027-02-03", 1, null, null, null, 100);
    // Simulate payment reported: intent moves to processing before booking creation.
    await db.collection("checkoutIntents").updateOne({ _id: intent._id, status: "pending" }, { $set: { status: "processing", updatedAt: new Date() } });
    let failed = false;
    try {
      await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-02-01", "2027-02-03", 1, null, null, null, 100);
    } catch (e) {
      failed = e.code === "INSUFFICIENT_INVENTORY" || e.statusCode === 409;
    }
    assert(failed, "Overlapping reservation must be rejected while intent is processing");
    // Complete payment: booking created atomically, intent becomes completed.
    const event = { id: `evt_gap_${Date.now()}`, type: "checkout.session.completed", data: { object: { id: `cs_gap_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_gap_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(["booking_created","already_processed"].includes(result.status), `Expected booking creation, got ${result.status}`);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    assert(bookings.length === 1, "Exactly one booking should exist");
  }),

  test("Cancellation racing with successful payment does not create inconsistent state", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-01-11", "2027-01-13", 1, null, null, null, 100);
    const event = { id: `evt_race_pay_${Date.now()}`, type: "checkout.session.completed", data: { object: { id: `cs_race_pay_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_race_pay_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    await Promise.all([
      releaseIntentReservation(db, intent._id, "cancelled").catch(() => null),
      handleStripeWebhook(db, event).catch(() => null),
    ]);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    const finalIntent = await db.collection("checkoutIntents").findOne({ _id: intent._id });
    assert(bookings.length <= 1, `Expected at most one booking, got ${bookings.length}`);
    if (bookings.length === 1) {
      assert(finalIntent.status === "completed", `Completed booking requires completed intent, got ${finalIntent.status}`);
    } else {
      assert(["cancelled","expired","pending"].includes(finalIntent.status), `No booking means intent not completed, got ${finalIntent.status}`);
    }
  }),


  test("Concurrent reservation: two customers cannot oversell the last available unit", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const startDate = new Date("2026-12-01");
    const endDate = new Date("2026-12-07");
    const [r1, r2] = await Promise.allSettled([
      reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), startDate, endDate, 1, "+1-555-0100", "123 Test St", "Concurrency", 100),
      reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), startDate, endDate, 1, "+1-555-0100", "123 Test St", "Concurrency", 100),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    assert(fulfilled.length === 1, `Expected exactly one success, got ${fulfilled.length}`);
    assert(rejected.length === 1, `Expected exactly one failure, got ${rejected.length}`);
    const intents = await db.collection("checkoutIntents").find({ equipmentId: equipment._id, status: "pending" }).toArray();
    assert(intents.length === 1, `Expected exactly one pending checkout intent, got ${intents.length}`);
  }),

  test("Non-overlapping dates can both be reserved successfully", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const a = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-01", "2026-12-03", 1, null, null, null, 100);
    const b = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-04", "2026-12-06", 1, null, null, null, 100);
    assert(a._id && b._id, "Both non-overlapping reservations should succeed");
  }),

  test("Quantity greater than one is supported for overlapping reservations", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 3 } });
    const a = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-10", "2026-12-12", 2, null, null, null, 200);
    const b = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-10", "2026-12-12", 1, null, null, null, 100);
    assert(a._id && b._id, "Reservations within total quantity should succeed");
  }),

  test("Partial available quantity rejects over-request", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 3 } });
    await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-15", "2026-12-17", 2, null, null, null, 200);
    let failed = false;
    try {
      await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-15", "2026-12-17", 2, null, null, null, 200);
    } catch (e) {
      failed = e.code === "INSUFFICIENT_INVENTORY" || e.statusCode === 409;
    }
    assert(failed, "Over-request against partial availability should fail");
  }),

  test("Cancellation releases reservation exactly once and restores availability", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-20", "2026-12-22", 1, null, null, null, 100);
    const first = await releaseIntentReservation(db, intent._id, "cancelled");
    const second = await releaseIntentReservation(db, intent._id, "cancelled");
    assert(first.released === true, "First cancellation should release");
    assert(second.released === false, "Second cancellation must not double-release");
    const again = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-20", "2026-12-22", 1, null, null, null, 100);
    assert(again._id, "Availability should be restored after single release");
  }),

  test("Expiration releases reservation exactly once and restores availability", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-23", "2026-12-25", 1, null, null, null, 100);
    await db.collection("checkoutIntents").updateOne({ _id: intent._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const first = await releaseIntentReservation(db, intent._id, "expired");
    const second = await releaseIntentReservation(db, intent._id, "expired");
    assert(first.released === true, "First expiration should release");
    assert(second.released === false, "Second expiration must not double-release");
    const again = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-23", "2026-12-25", 1, null, null, null, 100);
    assert(again._id, "Availability should be restored after expiration");
  }),

  test("Stripe session creation failure releases reservation", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-26", "2026-12-28", 1, null, null, null, 100);
    // Simulate route failure after reservation but before confirmed payment.
    const released = await releaseIntentReservation(db, intent._id, "expired");
    assert(released.released === true, "Reservation should be released on Stripe session failure");
    const again = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-26", "2026-12-28", 1, null, null, null, 100);
    assert(again._id, "Inventory should be restored after Stripe session creation failure");
  }),

  test("Webhook concurrency: duplicate event delivery is handled idempotently", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2026-12-29", "2026-12-31", 1, null, null, null, 100);
    const event = { id: `evt_dup_${Date.now()}`, type: "checkout.session.completed", data: { object: { id: `cs_dup_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_dup_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    await Promise.all([handleStripeWebhook(db, event), handleStripeWebhook(db, event)]);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    const payments = await db.collection("payments").find({ checkoutIntent: intent._id }).toArray();
    assert(bookings.length === 1, `Expected one booking, got ${bookings.length}`);
    assert(payments.length <= 1, `Expected at most one payment, got ${payments.length}`);
  }),

  test("Webhook idempotency: duplicate event after server restart is ignored", async () => {
    const eventId = `evt_restart_${Date.now()}`;
    await db.collection("webhookEvents").insertOne({ eventId, eventType: "checkout.session.completed", status: "completed", processedAt: new Date(), result: { received: true }, createdAt: new Date(), updatedAt: new Date() });
    const event = { id: eventId, type: "checkout.session.completed", data: { object: { id: "cs_restart", metadata: {} } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.received === true, "Replayed event should be handled safely");
  }),

  test("Different event IDs for same Checkout Session do not create duplicate booking/payment", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-01-02", "2027-01-04", 1, null, null, null, 100);
    const sessionObj = { id: `cs_same_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_same_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } };
    await handleStripeWebhook(db, { id: `evt_same_a_${Date.now()}`, type: "checkout.session.completed", data: { object: sessionObj } });
    await handleStripeWebhook(db, { id: `evt_same_b_${Date.now()}`, type: "checkout.session.completed", data: { object: sessionObj } });
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    const payments = await db.collection("payments").find({ stripeSessionId: sessionObj.id }).toArray();
    assert(bookings.length === 1, `Expected one booking, got ${bookings.length}`);
    assert(payments.length === 1, `Expected one payment, got ${payments.length}`);
  }),

  test("Webhook process restart recovers unfinished event after stale lease", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-01-05", "2027-01-07", 1, null, null, null, 100);
    const eventId = `evt_stale_${Date.now()}`;
    await db.collection("webhookEvents").insertOne({ eventId, eventType: "checkout.session.completed", status: "processing", leaseUntil: new Date(Date.now() - 1000), attempts: 1, createdAt: new Date(), updatedAt: new Date() });
    const event = { id: eventId, type: "checkout.session.completed", data: { object: { id: `cs_stale_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_stale_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(["booking_created","already_processed"].includes(result.status), `Expected recovered processing, got ${result.status}`);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    assert(bookings.length === 1, `Expected one booking after recovery, got ${bookings.length}`);
  }),

  test("Webhook partial failure: failed DB write followed by safe retry recovers", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    await db.collection("equipment").updateOne({ _id: equipment._id }, { $set: { totalQuantity: 1 } });
    const intent = await reserveCheckoutIntent(db, equipment._id.toString(), customerProfileId.toString(), ownerProfileId.toString(), "2027-01-08", "2027-01-10", 1, null, null, null, 100);
    const sessionObj = { id: `cs_retry_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_retry_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } };
    const paymentsColl = db.collection("payments");
    const origInsertOne = paymentsColl.insertOne.bind(paymentsColl);
    let injected = false;
    paymentsColl.insertOne = async (...args) => { if (!injected) { injected = true; throw new Error("Injected payment failure"); } return origInsertOne(...args); };
    let first;
    try { first = await handleStripeWebhook(db, { id: `evt_retry_${Date.now()}`, type: "checkout.session.completed", data: { object: sessionObj } }); } finally { paymentsColl.insertOne = origInsertOne; }
    assert(first.status === "transaction_failed" || first.status === "booking_created", `Expected transaction_failed or booking_created, got ${first.status}`);
    const second = await handleStripeWebhook(db, { id: `evt_retry2_${Date.now()}`, type: "checkout.session.completed", data: { object: sessionObj } });
    assert(["booking_created","already_processed","transaction_failed"].includes(second.status), `Expected handled retry, got ${second.status}`);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    const payments = await db.collection("payments").find({ stripeSessionId: sessionObj.id }).toArray();
    assert(bookings.length === 1, `Expected exactly one booking after retry, got ${bookings.length}`);
    assert(payments.length <= 1, `Expected at most one payment after retry, got ${payments.length}`);
  }),

  test("Cancellation race: customer cancels while payment is processing", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    await db.collection("checkoutIntents").updateOne({ _id: intent._id, status: "pending" }, { $set: { status: "cancelled", released: true, updatedAt: new Date() } });
    const event = { id: `evt_cancel_race_${Date.now()}`, type: "checkout.session.completed", data: { object: { id: `cs_cancel_race_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_cancel_race_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    const webhookResult = await handleStripeWebhook(db, event);
    assert(webhookResult.status !== "booking_created", "Webhook must not create booking for cancelled intent");
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    assert(bookings.length === 0, "No booking should be created for cancelled intent");
  }),

  test("Cancellation race: checkout.session.completed races with customer cancellation", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: `evt_race_${Date.now()}`, type: "checkout.session.completed", data: { object: { id: `cs_race_${Date.now()}`, payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: `pi_race_${Date.now()}`, metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString(), owner_id: ownerProfileId.toString() } } } };
    await Promise.all([
      db.collection("checkoutIntents").findOneAndUpdate({ _id: intent._id, status: "pending" }, { $set: { status: "cancelled", released: true, updatedAt: new Date() } }, { returnDocument: "after" }),
      handleStripeWebhook(db, event),
    ]);
    const bookings = await db.collection("bookings").find({ checkoutIntent: intent._id }).toArray();
    assert(bookings.length <= 1, `Expected at most one booking, got ${bookings.length}`);
  }),

  test("Payment validation: amount mismatch rejects booking creation", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: "evt_amount_mismatch", type: "checkout.session.completed", data: { object: { id: "cs_test_amount_mismatch", payment_status: "paid", amount_total: 5000, currency: "usd", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "amount_mismatch", `Expected amount_mismatch, got ${result.status}`);
    const intentAfter = await db.collection("checkoutIntents").findOne({ _id: intent._id });
    assert(intentAfter.status === "pending", "Intent should be reverted to pending");
  }),

  test("Payment validation: currency mismatch rejects booking creation", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: "evt_currency_mismatch", type: "checkout.session.completed", data: { object: { id: "cs_test_currency_mismatch", payment_status: "paid", amount_total: 10000, currency: "eur", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "currency_mismatch", `Expected currency_mismatch, got ${result.status}`);
  }),

  test("Payment validation: metadata mismatch rejects booking", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: "evt_meta_mismatch", type: "checkout.session.completed", data: { object: { id: "cs_test_metadata_mismatch", payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: new ObjectId().toString(), equipment_id: equipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "metadata_mismatch", `Expected metadata_mismatch, got ${result.status}`);
  }),

  test("Payment validation: wrong equipment ID rejects booking", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const otherEquipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: "evt_wrong_equipment", type: "checkout.session.completed", data: { object: { id: "cs_test_wrong_equipment", payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: otherEquipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "metadata_mismatch", `Expected metadata_mismatch, got ${result.status}`);
  }),

  test("Payment validation: expired intent rejects booking", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    await db.collection("checkoutIntents").updateOne({ _id: intent._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const event = { id: "evt_expired", type: "checkout.session.completed", data: { object: { id: "cs_test_expired", payment_status: "paid", amount_total: 10000, currency: "usd", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "intent_expired", `Expected intent_expired, got ${result.status}`);
  }),

  test("Payment validation: unpaid session does not create booking", async () => {
    const equipment = await createApprovedEquipmentForFavorites(db, ownerProfileId);
    const intent = await createCheckoutIntentForTest(db, customerProfileId, equipment._id, ownerProfileId, 100);
    const event = { id: "evt_unpaid", type: "checkout.session.completed", data: { object: { id: "cs_test_unpaid", payment_status: "unpaid", amount_total: 10000, currency: "usd", payment_intent: "pi_test", metadata: { checkout_intent_id: intent._id.toString(), user_id: customerProfileId.toString(), equipment_id: equipment._id.toString() } } } };
    const result = await handleStripeWebhook(db, event);
    assert(result.status === "payment_not_completed", `Expected payment_not_completed, got ${result.status}`);
    const intentAfter = await db.collection("checkoutIntents").findOne({ _id: intent._id });
    assert(intentAfter.status === "pending", "Intent should be reverted to pending");
  }),

];

async function createCheckoutIntentForTest(db, customerId, equipmentId, ownerId, totalPrice) {
  const intent = {
    equipmentId: new ObjectId(equipmentId),
    userId: new ObjectId(customerId),
    ownerId: new ObjectId(ownerId),
    startDate: new Date("2026-12-01"),
    endDate: new Date("2026-12-07"),
    quantity: 1,
    contactPhone: "+1-555-0100",
    deliveryAddress: "123 Test St",
    notes: "Test booking",
    totalPrice,
    currency: "usd",
    stripeSessionId: null,
    status: "pending",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    released: false,
    inventoryVersionSeen: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await db.collection("checkoutIntents").insertOne(intent);
  return { ...intent, _id: result.insertedId };
}

async function fetchJson(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  const body = await response.json();
  return { status: response.status, body };
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server.js"], {
      cwd: "D:/Projects/equipment-rental-platform/server",
      env: { ...process.env, PORT: PORT.toString(), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
      if (output.includes("Server running on port") || output.includes("Server is ready")) {
        resolve(proc);
      }
    });

    proc.stderr.on("data", (data) => {
      output += data.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Server process exited with code ${code}`);
        console.error(`Server output: ${output}`);
      }
    });

    setTimeout(() => {
      reject(new Error("Server startup timeout"));
    }, 30000);
  });
}

async function waitForServer() {
  let retries = 0;
  const maxRetries = 30;
  while (retries < maxRetries) {
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore errors
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    retries++;
  }
  throw new Error("Server did not become ready");
}

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
    await closeAppDB().catch(() => {});
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
