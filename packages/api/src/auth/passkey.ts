import {
  generateRegistrationOptions as swGenerateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions as swGenerateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import { query } from '../db/postgres.js';

const RP_ID = process.env.OVERBEARER_RP_ID || 'localhost';
const RP_NAME = 'Overbearer';
const ORIGIN = process.env.OVERBEARER_ORIGIN || `http://${RP_ID}:3000`;

/** Challenges expire after 5 minutes. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[] | null;
}

interface ChallengeRow {
  id: string;
  challenge: string;
  user_id: string | null;
  type: string;
  expires_at: string;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
}

/**
 * Clean up expired challenges from the database.
 */
async function cleanupExpiredChallenges(): Promise<void> {
  await query('DELETE FROM webauthn_challenges WHERE expires_at < NOW()');
}

/**
 * Generate registration options for a user to register a new passkey.
 */
export async function generateRegistrationOpts(
  userId: string,
  username: string,
): Promise<ReturnType<typeof swGenerateRegistrationOptions>> {
  await cleanupExpiredChallenges();

  // Fetch existing credentials for exclusion
  const existingCreds = await query<PasskeyCredentialRow>(
    'SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1',
    [userId],
  );

  const excludeCredentials = existingCreds.rows.map((cred) => ({
    id: cred.credential_id,
    transports: (cred.transports ?? []) as AuthenticatorTransportFuture[],
  }));

  const options = await swGenerateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    timeout: CHALLENGE_TTL_MS,
  });

  // Store challenge in DB
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await query(
    `INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
     VALUES ($1, $2, 'registration', $3)`,
    [options.challenge, userId, expiresAt],
  );

  return options;
}

/**
 * Verify a registration response and store the credential.
 */
export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
): Promise<boolean> {
  // Look up the stored challenge
  const challengeResult = await query<ChallengeRow>(
    `SELECT * FROM webauthn_challenges
     WHERE user_id = $1 AND type = 'registration' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );

  if (challengeResult.rows.length === 0) {
    throw new Error('No valid registration challenge found');
  }

  const storedChallenge = challengeResult.rows[0].challenge;

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: storedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return false;
  }

  const { credential } = verification.registrationInfo;

  // Store credential in DB
  await query(
    `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? [],
    ],
  );

  // Clean up the used challenge
  await query('DELETE FROM webauthn_challenges WHERE id = $1', [challengeResult.rows[0].id]);

  return true;
}

/**
 * Generate authentication options (for login).
 */
export async function generateAuthenticationOpts(): Promise<
  ReturnType<typeof swGenerateAuthenticationOptions>
> {
  await cleanupExpiredChallenges();

  const options = await swGenerateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    timeout: CHALLENGE_TTL_MS,
  });

  // Store challenge in DB (no user_id since we don't know who is logging in yet)
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  await query(
    `INSERT INTO webauthn_challenges (challenge, type, expires_at)
     VALUES ($1, 'authentication', $2)`,
    [options.challenge, expiresAt],
  );

  return options;
}

/**
 * Verify an authentication response. Returns the user if successful.
 */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
): Promise<UserRow> {
  // Find the credential
  const credResult = await query<PasskeyCredentialRow>(
    `SELECT * FROM passkey_credentials WHERE credential_id = $1`,
    [response.id],
  );

  if (credResult.rows.length === 0) {
    throw new Error('Credential not found');
  }

  const credRow = credResult.rows[0];

  // Find a valid authentication challenge
  const challengeResult = await query<ChallengeRow>(
    `SELECT * FROM webauthn_challenges
     WHERE type = 'authentication' AND expires_at > NOW()
     ORDER BY created_at DESC`,
  );

  if (challengeResult.rows.length === 0) {
    throw new Error('No valid authentication challenge found');
  }

  // Try each challenge until one works (multiple users may be logging in)
  let verification;
  let matchedChallenge: ChallengeRow | null = null;

  for (const ch of challengeResult.rows) {
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credRow.credential_id,
          publicKey: new Uint8Array(credRow.public_key),
          counter: Number(credRow.counter),
          transports: (credRow.transports ?? []) as AuthenticatorTransportFuture[],
        },
      });
      if (verification.verified) {
        matchedChallenge = ch;
        break;
      }
    } catch {
      // Try next challenge
    }
  }

  if (!verification?.verified || !matchedChallenge) {
    throw new Error('Authentication failed');
  }

  // Update counter
  await query(
    'UPDATE passkey_credentials SET counter = $1 WHERE id = $2',
    [verification.authenticationInfo.newCounter, credRow.id],
  );

  // Clean up used challenge
  await query('DELETE FROM webauthn_challenges WHERE id = $1', [matchedChallenge.id]);

  // Return the user
  const userResult = await query<UserRow>(
    'SELECT id, username, display_name, role FROM users WHERE id = $1',
    [credRow.user_id],
  );

  if (userResult.rows.length === 0) {
    throw new Error('User not found');
  }

  return userResult.rows[0];
}
