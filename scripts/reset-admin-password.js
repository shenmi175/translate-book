#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resetAdminPasswordFromServer } from "../server/lib/task-service.js";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] || "";
}

function usage() {
  console.log(`Usage:
  node scripts/reset-admin-password.js --username admin --password 'new-password'
  node scripts/reset-admin-password.js --username admin --generate

This command runs on the server and clears the login lock.`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}

const username = readArg("--username") || "admin";
const generated = process.argv.includes("--generate");
const password = generated ? randomBytes(18).toString("base64url") : readArg("--password");

if (!password) {
  usage();
  process.exit(1);
}

try {
  const result = resetAdminPasswordFromServer({ username, password });
  console.log(`Admin password reset for: ${result.auth.username}`);
  if (generated) {
    console.log(`Generated password: ${password}`);
  }
  console.log("The account is unlocked and existing browser sessions were revoked.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
