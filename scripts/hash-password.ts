import { hashPassword } from '../src/web/login.ts';

// EVERFLOW_PASSWORD=... node scripts/hash-password.ts  ->  the EVERFLOW_LOGIN_HASH value for that password.
// From the environment, never an argument, so the password stays out of process listings and shell history.
const password = process.env.EVERFLOW_PASSWORD ?? '';
if (!password) { console.error('EVERFLOW_PASSWORD is empty'); process.exit(2); }
console.log(hashPassword(password));
