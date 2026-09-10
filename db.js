// db.js
//
// This is a deliberately simple "database": one JSON file on disk.
// It's fine for building, testing, and even a small early launch.
// Once you have real concurrent traffic, swap this for Postgres
// (Supabase or Railway both give you one for free to start) --
// every function below keeps the same shape (readUsers/writeUsers),
// so the rest of the app doesn't need to change, just this file.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'users.json');

function ensureDbFile() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
  }
}
function readUsers() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw).users;
}

function writeUsers(users) {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify({ users }, null, 2));
}

function findUserByEmail(email) {
  return readUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
}

function findUserById(id) {
  return readUsers().find(u => u.id === id);
}

function createUser(user) {
  const users = readUsers();
  users.push(user);
  writeUsers(users);
  return user;
}

function updateUser(id, updates) {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...updates };
  writeUsers(users);
  return users[idx];
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  updateUser,
};
