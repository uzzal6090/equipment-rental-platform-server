import * as dns from "dns";
import { config as dotenvConfig } from "dotenv";
import { MongoClient } from "mongodb";

dotenvConfig();

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || "equipment_rental_db";

let client;
let db;
let isConnected = false;

function configureDNS() {
  const dnsServers = process.env.DNS_SERVERS;
  if (!dnsServers) {
    return;
  }
  const servers = dnsServers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length === 0) {
    return;
  }
  dns.setServers(servers);
}

async function connectDB() {
  if (isConnected && db) {
    return db;
  }

  if (!uri) {
    const error = new Error("MONGODB_URI is not defined in environment variables");
    error.code = "MISSING_MONGODB_URI";
    throw error;
  }

  console.error("[connectDB] Using MONGODB_URI:", uri.substring(0, 50) + "...");
  console.error("[connectDB] Using DB_NAME:", dbName);

  configureDNS();

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    isConnected = true;
    console.log("Connected to MongoDB database:", dbName);
    return db;
  } catch (error) {
    isConnected = false;
    client = undefined;
    db = undefined;
    console.error("Failed to connect to MongoDB:", error.message);
    throw error;
  }
}

function getDB() {
  if (!isConnected || !db) {
    const error = new Error("Database is not connected");
    error.code = "DB_NOT_CONNECTED";
    throw error;
  }
  return db;
}

function getClient() {
  if (!isConnected || !client) {
    const error = new Error("Database client is not connected");
    error.code = "DB_NOT_CONNECTED";
    throw error;
  }
  return client;
}

async function verifyTransactionSupport() {
  const session = getClient().startSession();
  try {
    await session.startTransaction();
    // Perform a real harmless transactional write and roll it back so nothing
    // persists. No existing user data is touched.
    const db = getDB();
    await db.collection("_transaction_verification").insertOne(
      { verifiedAt: new Date(), check: true },
      { session }
    );
    await session.abortTransaction();
    return true;
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (_) {
      // Ignore abort errors; the verification failure takes precedence.
    }
    return false;
  } finally {
    session.endSession();
  }
}

async function withTransaction(fn, options = {}) {
  const session = getClient().startSession();
  try {
    // Use the driver's session.withTransaction() callback API. The driver owns
    // TransientTransactionError and UnknownTransactionCommitResult retry
    // semantics. We do not manually start/commit/abort and never blindly rerun
    // an uncertain commit. Custom inventory-version conflicts propagate out and
    // are retried by the outer withInventoryGuard() loop using a fresh
    // transaction.
    return await session.withTransaction(fn, options);
  } finally {
    await session.endSession();
  }
}

async function closeDB() {
  if (client) {
    await client.close();
    isConnected = false;
    client = undefined;
    db = undefined;
    console.log("Disconnected from MongoDB");
  }
}

export { connectDB, getDB, getClient, closeDB, withTransaction, verifyTransactionSupport };
