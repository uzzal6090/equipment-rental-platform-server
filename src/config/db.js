const dns = require("dns");
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = "equipment_rental_db";

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

async function closeDB() {
  if (client) {
    await client.close();
    isConnected = false;
    client = undefined;
    db = undefined;
    console.log("Disconnected from MongoDB");
  }
}

module.exports = { connectDB, getDB, closeDB };
