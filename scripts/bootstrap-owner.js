#!/usr/bin/env node
/**
 * Owner Bootstrap Script
 * 
 * Secure, one-time script to promote an existing Customer account to Owner.
 * This script promotes an existing Customer account to Owner by updating
 * the profile's role to "owner" and incrementing roleVersion.
 * 
 * Usage:
 *   npm run bootstrap:owner -- --email owner@example.com
 *   npm run bootstrap:owner:inspect -- --email owner@example.com
 */

import { config as dotenvConfig } from "dotenv";
import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";
import * as dns from "dns";
import { stdin, stdout } from "process";
import readline from "readline/promises";

// Load environment configuration (only if not already set by caller)
if (!process.env.MONGODB_URI) {
  dotenvConfig();
}

const REQUIRED_CONFIRMATION_PHRASE = "PROMOTE TO OWNER";
const ALLOWED_ROLES = ["customer", "owner", "admin"];
const TARGET_ROLE = "owner";
const SOURCE_ROLE = "customer";

class BootstrapOwner {
  constructor() {
    this.uri = process.env.MONGODB_URI;
    this.dbName = process.env.DB_NAME || "equipment_rental_db";
    this.client = null;
    this.db = null;
    this.isTestDb = false;
  }

  async connect() {
    if (!this.uri) {
      throw new Error("MONGODB_URI is not defined in environment variables");
    }

    // Configure DNS if needed
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

    // Verify database name is exactly the test database
    if (this.dbName !== "equipment_rental_test_db") {
      throw new Error(`This script only works with the test database 'equipment_rental_test_db'. Current DB_NAME: ${this.dbName}`);
    }

    this.isTestDb = true;
    console.log("⚠️  TEST DATABASE DETECTED:", this.dbName);

    this.client = new MongoClient(this.uri);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    console.log("✅ Connected to MongoDB database:", this.dbName);
  }

  async close() {
    if (this.client) {
      await this.client.close();
      console.log("🔌 Disconnected from MongoDB");
    }
  }

  async inspect(email) {
    console.log("\n🔍 Inspecting account:", email);
    
    // Find user in Better Auth user collection
    const user = await this.db.collection("user").findOne({ email: email.toLowerCase() });
    if (!user) {
      console.log("❌ No Better Auth user found with email:", email);
      return { user: null, profile: null };
    }

    console.log("✅ Better Auth user found:", user._id);

    // Find profile (_id is the MongoDB primary key; betterAuthUserId is stored as string)
    const profile = await this.db.collection("profiles").findOne({ betterAuthUserId: user._id.toString() });
    if (!profile) {
      console.log("❌ No application profile found for user:", user._id);
      return { user, profile: null };
    }

    console.log("✅ Profile found:", profile._id);
    console.log("   Name:", profile.name);
    console.log("   Email:", profile.email);
    console.log("   Role:", profile.role);
    console.log("   Role Version:", profile.roleVersion);
    console.log("   Created At:", profile.createdAt);
    console.log("   Updated At:", profile.updatedAt);

    return { user, profile };
  }

  async promote(email, dryRun = false) {
    console.log("\n🚀 Owner Bootstrap Process");
    console.log("=".repeat(50));
    console.log("Target Email:", email);
    console.log("Current Role:", "customer");
    console.log("Target Role:", TARGET_ROLE);
    console.log("Database:", this.dbName);
    console.log("Collection: profiles");
    console.log("=".repeat(50));

    // Step 1: Find user and profile
    const { user, profile } = await this.inspect(email);
    if (!user) {
      throw new Error(`No Better Auth user found with email: ${email}`);
    }
    if (!profile) {
      throw new Error(`No application profile found for user: ${email}`);
    }

    // Step 2: Validate current role
    if (profile.role === "owner") {
      throw new Error(`Account is already an Owner (role: owner, roleVersion: ${profile.roleVersion})`);
    }

    if (profile.role === "admin") {
      throw new Error(`Cannot promote Admin account to Owner. Current role: admin. Please change role to customer first if needed.`);
    }

    if (profile.role !== "customer") {
      throw new Error(`Only Customer accounts can be promoted via bootstrap. Current role: ${profile.role}`);
    }

    // Step 3: Confirmation
    if (!dryRun) {
      console.log("\n⚠️  This will permanently change the account role from 'customer' to 'owner'.");
      console.log("   Role version will be incremented from", profile.roleVersion, "to", profile.roleVersion + 1);
      console.log("   This will invalidate all existing JWT tokens for this user.");
      
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const confirmation = await rl.question(
        `\nType "${REQUIRED_CONFIRMATION_PHRASE}" to confirm promotion: `
      );
      rl.close();

      if (confirmation !== REQUIRED_CONFIRMATION_PHRASE) {
        throw new Error("Confirmation phrase does not match. Operation cancelled.");
      }
    }

    // Step 4: Perform atomic update
    console.log("\n🔄 Updating profile...");

    const result = await this.db.collection("profiles").findOneAndUpdate(
      { betterAuthUserId: profile.betterAuthUserId },
      {
        $set: {
          role: TARGET_ROLE,
          updatedAt: new Date(),
        },
        $inc: {
          roleVersion: 1,
        },
      },
      { returnDocument: "after" }
    );

    if (!result) {
      throw new Error("Failed to update profile - no document returned");
    }

    const updatedProfile = result;
    console.log("✅ Profile updated successfully!");
    console.log("   Role:", updatedProfile.role);
    console.log("   Role Version:", updatedProfile.roleVersion);
    console.log("   Updated At:", updatedProfile.updatedAt);

    // Verify the update
    if (updatedProfile.role !== TARGET_ROLE) {
      throw new Error("Role was not updated correctly");
    }

    if (updatedProfile.roleVersion !== profile.roleVersion + 1) {
      throw new Error("Role version was not incremented correctly");
    }

    // Verify no other fields were modified
    const preservedFields = ["name", "email", "profileImage", "phone", "address", "createdAt"];
    for (const field of preservedFields) {
      if (JSON.stringify(profile[field]) !== JSON.stringify(updatedProfile[field])) {
        console.warn(`⚠️  Warning: Field '${field}' was modified during update`);
      }
    }

    // Verify no other user was modified
    const otherOwners = await this.db.collection("profiles").countDocuments({ role: "owner" });
    console.log("\n📊 Total Owner accounts now:", otherOwners);

    return updatedProfile;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const emailArg = args.find(arg => arg.startsWith("--email="));
  const email = emailArg ? emailArg.split("=")[1] : null;

  if (!command || !["bootstrap", "inspect"].includes(command)) {
    console.error("Usage:");
    console.log("  node scripts/bootstrap-owner.js bootstrap --email=user@example.com");
    console.log("  node scripts/bootstrap-owner.js inspect --email=user@example.com");
    console.log("\nOr via npm:");
    console.log("  npm run bootstrap:owner -- --email=user@example.com");
    console.log("  npm run bootstrap:owner:inspect -- --email=user@example.com");
    process.exit(1);
  }

  if (!email) {
    console.error("Error: --email parameter is required");
    process.exit(1);
  }

  // Basic email validation
  if (!email.includes("@")) {
    console.error("Error: Invalid email format");
    process.exit(1);
  }

  const bootstrap = new BootstrapOwner();

  try {
    await bootstrap.connect();

    if (command === "inspect") {
      await bootstrap.inspect(email);
    } else if (command === "bootstrap") {
      await bootstrap.promote(email, false);
    }

    console.log("\n✅ Operation completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  } finally {
    await bootstrap.close();
  }
}

main().catch(console.error);