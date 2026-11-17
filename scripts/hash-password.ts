import { hashPassword, stableSalt } from '../src/web/login.ts';

// EVERFLOW_PASSWORD=... node scripts/hash-password.ts  ->  the EVERFLOW_LOGIN_HASH value for that password, random salt.
// --stable (the deploy pipeline): the salt comes from EVERFLOW_USER, so the same user and password give the same hash on every
// deploy and the page sessions signed with it survive; a changed user or password changes it and ends them.
// From the environment, never an argument, so the password stays out of process listings and shell history.
const password = process.env.EVERFLOW_PASSWORD ?? '';
if (!password) { console.error('EVERFLOW_PASSWORD is empty'); process.exit(2); }
if (!process.argv.includes('--stable')) { console.log(hashPassword(password)); process.exit(0); }
const user = process.env.EVERFLOW_USER?.trim() ?? '';
if (!user) { console.error('EVERFLOW_USER is empty'); process.exit(2); }
console.log(hashPassword(password, stableSalt(user)));
