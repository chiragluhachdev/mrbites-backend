const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../utils/secrets');

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

/**
 * Verifies a token outside the request cycle — used by the socket handshake,
 * which has no res to answer with. Returns the payload, or null.
 */
const verifyToken = (token) => {
  if (!token) return null;
  try {
    return jwt.verify(String(token), JWT_SECRET);
  } catch {
    return null;
  }
};

// Admins are trusted everywhere a vendor is, so vendor-only routes accept both.
const requireVendor = (req, res, next) => {
  authenticate(req, res, () => {
    const role = req.user?.role;
    if (role !== 'vendor' && role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    next();
  });
};

const requireAdmin = (req, res, next) => {
  authenticate(req, res, () => {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    next();
  });
};

/**
 * True when the caller may act on this outlet. Admins may act on any; a vendor
 * only on the one its token was issued for.
 *
 * Without this, any vendor passkey grants write access to every other outlet's
 * menu, settings and orders — `requireVendor` alone only proves the caller is
 * *a* vendor, not *this* vendor.
 */
const ownsOutlet = (user, restaurantId) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return String(user.restaurantId) === String(restaurantId);
};

module.exports = { authenticate, verifyToken, requireVendor, requireAdmin, ownsOutlet };
