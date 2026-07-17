// The app-store review account.
//
// Apple and Google reviewers need a login that works without a real phone or a
// real card. This is that login: a fixed number whose OTP is always the same and
// never goes through Fast2SMS, tied to an account whose checkout is always demo.
//
// It is a deliberate, narrow backdoor — exactly one number, a normal customer
// with no privileges, and (paired with demo mode) no way to move real money. The
// values are env-overridable so they can be rotated or the number changed
// without a code edit; the defaults are what ship if nothing is set.
//
// Give the reviewer: this phone number, and OTP 123456.

const DEMO_PHONE = String(process.env.DEMO_PHONE || '9999999999').replace(/\D/g, '');
const DEMO_LOGIN_OTP = String(process.env.DEMO_LOGIN_OTP || '123456');
const DEMO_NAME = process.env.DEMO_NAME || 'Demo Reviewer';

const isDemoPhone = (phone) => Boolean(phone) && String(phone) === DEMO_PHONE;

module.exports = { DEMO_PHONE, DEMO_LOGIN_OTP, DEMO_NAME, isDemoPhone };
