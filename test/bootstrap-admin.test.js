import { config as dotenvConfig } from "dotenv";
import * as dns from "dns";
import { MongoClient, ObjectId } from "mongodb";
import { spawn } from "child_process";

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
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;

// Safety: verify we are using the test database, not production
if (DB_NAME !== "equipment_rental_test_db") {
  console.error(`ERROR: Test database must be equipment_rental_test_db, but got: ${DB_NAME}`);
  process.exit(1);
}

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

async function connectTestDb() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  console.log(`Connected to test database: ${db.databaseName}`);

  // Verify database name is exactly equipment_rental_test_db
  if (db.databaseName !== "equipment_rental_test_db") {
    throw new Error(`Database name mismatch: expected equipment_rental_test_db, got ${db.databaseName}`);
  }
}

async function insertBootstrapFixtures() {
  // Clean up first to ensure clean state
  await db.collection("profiles").deleteMany({});
  await db.collection("user").deleteMany({});

  // Insert test users and profiles
  const users = [
    {
      _id: new ObjectId(),
      name: "Test Customer",
      email: "customer@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: new ObjectId(),
      name: "Test Owner",
      email: "owner@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: new ObjectId(),
      name: "Test Admin",
      email: "admin@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: new ObjectId(),
      name: "Another Customer",
      email: "another@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await db.collection("user").insertMany(users);
  console.log(`Inserted ${users.length} test users`);

  // Insert profiles
  const profiles = [
    {
      betterAuthUserId: users[0]._id.toString(),
      name: "Test Customer",
      email: "customer@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      betterAuthUserId: users[1]._id.toString(),
      name: "Test Owner",
      email: "owner@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "owner",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      betterAuthUserId: users[2]._id.toString(),
      name: "Test Admin",
      email: "admin@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "admin",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      betterAuthUserId: users[3]._id.toString(),
      name: "Another Customer",
      email: "another@example.com",
      profileImage: null,
      phone: null,
      address: null,
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await db.collection("profiles").insertMany(profiles);
  console.log(`Inserted ${profiles.length} profile fixtures`);
}

async function cleanupFixtures() {
  await db.collection("profiles").deleteMany({});
  await db.collection("user").deleteMany({});
  console.log("Cleaned up test fixtures");
}

// --- Helper to run bootstrap script ---
async function runBootstrapScript(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["scripts/bootstrap-admin.js", ...args], {
      cwd: "D:/Projects/equipment-rental-platform/server",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      reject(err);
    });

    // Auto-confirm bootstrap operations (piping confirmation phrase to stdin)
    if (args[0] === "bootstrap") {
      proc.stdin.write("PROMOTE TO ADMIN\n");
      proc.stdin.end();
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.kill();
      reject(new Error("Script timed out after 30 seconds"));
    }, 30000);
  });
}

// --- Tests ---

const runTests = [
  test("1. Existing Customer promotion to Admin", async () => {
    await insertBootstrapFixtures();

    const result = await runBootstrapScript(["bootstrap", "--email=customer@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code === 0, `Expected exit code 0, got ${result.code}: ${result.stderr}`);
    assert(result.stdout.includes("Profile updated successfully"), "Should show success message");
    assert(result.stdout.includes("Role Version: 1"), "Role version should be incremented to 1");

    // Verify database state
    const profile = await db.collection("profiles").findOne({ email: "customer@example.com" });
    assert(profile.role === "admin", "Role should be admin");
    assert(profile.roleVersion === 1, "Role version should be 1");
    assertEqual(profile.name, "Test Customer", "Name should be preserved");
    assertEqual(profile.email, "customer@example.com", "Email should be preserved");
  }),

  test("2. Missing email argument", async () => {
    const result = await runBootstrapScript(["bootstrap"], { DB_NAME: "equipment_rental_test_db" });

    assert(result.code !== 0, "Should fail with non-zero exit code");
    assert(
      result.stderr.includes("--email parameter is required") ||
        result.stdout.includes("--email parameter is required"),
      "Should require email parameter"
    );
  }),

  test("3. Nonexistent user", async () => {
    await insertBootstrapFixtures();

    const result = await runBootstrapScript(["bootstrap", "--email=nonexistent@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code !== 0, "Should fail with non-zero exit code");
    assert(
      result.stderr.includes("No Better Auth user found") ||
        result.stdout.includes("No Better Auth user found"),
      "Should report user not found"
    );
  }),

  test("3b. Nonexistent user with inspect command", async () => {
    const result = await runBootstrapScript(["inspect", "--email=nonexistent@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code === 0, "Should exit with code 0");
    assert(
      result.stdout.includes("No Better Auth user found") ||
        result.stderr.includes("No Better Auth user found"),
      "Should report user not found"
    );
  }),

  test("4. Missing profile", async () => {
    await insertBootstrapFixtures();

    // Create a user without a profile
    const userId = new ObjectId();
    await db.collection("user").insertOne({
      _id: userId,
      name: "No Profile User",
      email: "noprofile@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await runBootstrapScript(["bootstrap", "--email=noprofile@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code !== 0, "Should fail with non-zero exit code");
    assert(
      result.stderr.includes("No application profile found") ||
        result.stdout.includes("No application profile found"),
      "Should report profile not found"
    );
  }),

  test("5. Already Admin account rejection", async () => {
    await insertBootstrapFixtures();

    const result = await runBootstrapScript(["bootstrap", "--email=admin@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code !== 0, "Should fail with non-zero exit code");
    assert(
      result.stderr.includes("already an Admin") ||
        result.stdout.includes("already an Admin"),
      "Should report already admin"
    );
  }),

  test("6. Owner account rejection", async () => {
    await insertBootstrapFixtures();

    const result = await runBootstrapScript(["bootstrap", "--email=owner@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code !== 0, "Should fail with non-zero exit code");
    assert(
      result.stderr.includes("Cannot promote Owner") ||
        result.stdout.includes("Cannot promote Owner"),
      "Should reject owner account"
    );
  }),

  test("7. roleVersion increment", async () => {
    await insertBootstrapFixtures();

    // First check initial roleVersion
    const beforeProfile = await db.collection("profiles").findOne({ email: "customer@example.com" });
    const initialRoleVersion = beforeProfile.roleVersion;

    const result = await runBootstrapScript(["bootstrap", "--email=customer@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code === 0, `Expected exit code 0, got ${result.code}: ${result.stderr}`);

    const afterProfile = await db.collection("profiles").findOne({ email: "customer@example.com" });
    assertEqual(afterProfile.roleVersion, initialRoleVersion + 1, "roleVersion should increment by 1");
  }),

  test("8. Preservation of unrelated profile fields", async () => {
    await insertBootstrapFixtures();

    // Use another customer
    const beforeProfile = await db.collection("profiles").findOne({ email: "another@example.com" });

    const result = await runBootstrapScript(["bootstrap", "--email=another@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code === 0, `Expected exit code 0, got ${result.code}: ${result.stderr}`);

    const afterProfile = await db.collection("profiles").findOne({ email: "another@example.com" });
    assertEqual(afterProfile.name, "Another Customer", "Name should be preserved");
    assertEqual(afterProfile.email, "another@example.com", "Email should be preserved");
    assertEqual(afterProfile.profileImage, null, "Profile image should be preserved");
    assertEqual(afterProfile.phone, null, "Phone should be preserved");
    assertEqual(afterProfile.address, null, "Address should be preserved");
    assertEqual(afterProfile.createdAt.toISOString(), beforeProfile.createdAt.toISOString(), "CreatedAt should be preserved");
  }),

  test("9. No accidental modification of another user", async () => {
    await insertBootstrapFixtures();

    const beforeCustomer = await db.collection("profiles").findOne({ email: "customer@example.com" });
    const beforeAnother = await db.collection("profiles").findOne({ email: "another@example.com" });

    // Promote another@example.com
    const result = await runBootstrapScript(["bootstrap", "--email=another@example.com"], {
      DB_NAME: "equipment_rental_test_db",
    });

    assert(result.code === 0, `Expected exit code 0, got ${result.code}: ${result.stderr}`);

    // Check that customer@example.com was not modified
    const afterCustomer = await db.collection("profiles").findOne({ email: "customer@example.com" });
    assertEqual(afterCustomer.role, "customer", "Other user's role should not change");
    assertEqual(afterCustomer.roleVersion, 0, "Other user's roleVersion should not change");

    // Check that another@example.com was modified
    const afterAnother = await db.collection("profiles").findOne({ email: "another@example.com" });
    assertEqual(afterAnother.role, "admin", "Target user should be promoted");
    assertEqual(afterAnother.roleVersion, 1, "Target user's roleVersion should increment");
  }),

  test("10. Confirmation cancellation causes no database write", async () => {
    await insertBootstrapFixtures();

    const beforeProfile = await db.collection("profiles").findOne({ email: "another@example.com" });

    // Create a test that simulates wrong confirmation by piping input
    const proc = spawn("node", ["scripts/bootstrap-admin.js", "bootstrap", "--email=another@example.com"], {
      cwd: "D:/Projects/equipment-rental-platform/server",
      env: { ...process.env, DB_NAME: "equipment_rental_test_db" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Wait for the confirmation prompt, then send wrong answer
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.stdin.write("WRONG_CONFIRMATION\n");
        resolve();
      }, 2000);

      proc.stdout.on("data", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    proc.stdin.write("WRONG_CONFIRMATION\n");
    proc.stdin.end();

    await new Promise((resolve) => proc.on("close", resolve));

    // Verify no database changes
    const afterProfile = await db.collection("profiles").findOne({ email: "another@example.com" });
    assertEqual(afterProfile.role, "customer", "Role should not change after cancelled confirmation");
    assertEqual(afterProfile.roleVersion, 0, "Role version should not change after cancelled confirmation");
  }),
];

async function main() {
  console.log("=== Bootstrap Admin Script Test Suite ===\n");
  console.log(`Test database: ${DB_NAME}\n`);

  await connectTestDb();

  try {
    console.log("\nRunning tests:\n");
    for (const t of runTests) {
      await t();
    }
  } finally {
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