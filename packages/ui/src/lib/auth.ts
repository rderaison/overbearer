import { auth, type User } from './api';

/**
 * Full passkey registration flow.
 */
export async function registerPasskey(username: string): Promise<User> {
  const { startRegistration } = await import('@simplewebauthn/browser');

  // Server returns { options: {...}, userId, role }
  const regResponse = await auth.registerOptions(username) as any;
  const optionsJSON = regResponse.options ?? regResponse;
  const userId = regResponse.userId;

  const credential = await startRegistration({ optionsJSON });
  const { user } = await auth.register(userId, credential);
  return user;
}

/**
 * Full passkey authentication flow.
 */
export async function loginWithPasskey(): Promise<User> {
  const { startAuthentication } = await import('@simplewebauthn/browser');

  // Server returns { options: {...} }
  const loginResponse = await auth.loginOptions() as any;
  const optionsJSON = loginResponse.options ?? loginResponse;

  const credential = await startAuthentication({ optionsJSON });
  const { user } = await auth.login(credential);
  return user;
}
