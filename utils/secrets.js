// Secrets are validated once, at boot, and the process refuses to start without
// them.
//
// Every signing call used to read `process.env.JWT_SECRET || 'secret'`. That
// fails *open*: with the variable unset — a typo'd deploy, a missing .env — the
// server would come up looking healthy while signing tokens with a string an
// attacker can read in this repository, and anyone could mint themselves an
// admin session. A server that will not start is a far better outcome than one
// that quietly trusts forged tokens.
//
// dotenv is loaded by server.js before any router (and therefore this module) is
// required, so reading process.env here is safe.

const MIN_SECRET_LENGTH = 32;

const fatal = (message) => {
  console.error(`\n✖ Startup aborted: ${message}\n`);
  process.exit(1);
};

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  fatal('JWT_SECRET is not set. Generate one with:  openssl rand -hex 32');
}
if (JWT_SECRET.length < MIN_SECRET_LENGTH) {
  fatal(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${JWT_SECRET.length}).`);
}
if (JWT_SECRET === 'secret' || JWT_SECRET === 'changeme') {
  fatal('JWT_SECRET is a placeholder value. Generate a real one:  openssl rand -hex 32');
}

module.exports = { JWT_SECRET };
