// Ids and clock shared by the domain stores. One copy, so tests stub nothing twice.

function uuid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return Date.now();
}

module.exports = { uuid, now };
