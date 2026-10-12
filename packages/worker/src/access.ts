// Who is calling the admin Worker: the email in the Cloudflare Access token, and nothing the
// request says about itself. Access checks the login at the edge before the Worker runs; this
// checks again - issuer, this application's audience, signature, expiry - so a token Access
// issued for another application of the team is refused, and so is a request that reaches
// the Worker some other way (a preview URL without Access, a misconfigured toggle).
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  issuer: string;
  audience: string;
  /** Lowercase; "@domain" admits the domain, anything else one exact address */
  allow: string[];
}

/** ACCESS_ALLOW as a list: "@yolean.com, name@partner.example" */
export const parseAllow = (value: string | undefined): string[] =>
  (value ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

export class AccessError extends Error {}

const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

/** The team's signing keys, once per isolate; jose refetches on an unknown kid, so rotation needs no restart */
export function accessJwks(issuer: string): JWTVerifyGetKey {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

/** The token Access forwards to the Worker; the CLI's cf-access-token header becomes this at the edge */
export function accessToken(request: Request): string {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new AccessError('no Access token');
  return token;
}

export async function accessEmail(token: string, config: AccessConfig, jwks: JWTVerifyGetKey): Promise<string> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    throw new AccessError(`token not accepted: ${(err as Error).message}`);
  }
  // A service token has no email: media is always managed on behalf of a person
  if (typeof payload.email !== 'string' || payload.email.length === 0) throw new AccessError('token has no email');
  const email = payload.email.toLowerCase();
  const allowed = config.allow.some((entry) => (entry.startsWith('@') ? email.endsWith(entry) : email === entry));
  if (!allowed) throw new AccessError(`${email} is not in ACCESS_ALLOW`);
  return email;
}
