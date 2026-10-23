/**
 * @jest-environment node
 *
 * MOCKED identity verifier. This file does not contact Firebase Auth and is
 * not a production authentication test.
 */
import { INFERENCE_TOKEN_HEADER } from '@/server/inferenceUpstream';
import {
  gateHostedStagingThenForward,
  parseStagingAllowlist,
} from '@/server/hostedStagingAuth';

const SECRET = 'staging-secret-0123456789abcdef0123456789abcd';
const UID = 'allowlisted-uid-001';
const TOKEN = 'header.payload.signature';

function stagingEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CHORDMINI_HOSTED_STAGING_AUTH: 'required',
    CHORDMINI_STAGING_ALLOWED_UIDS: UID,
    CHORDMINI_INFERENCE_AUTH: 'required',
    CHORDMINI_INFERENCE_SECRET: SECRET,
    FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    }),
    ...extra,
  };
}

describe('MOCKED hosted staging identity gate', () => {
  it('fails closed when the allowlist is missing, empty, or malformed', () => {
    expect(parseStagingAllowlist({}).ok).toBe(false);
    expect(parseStagingAllowlist({ CHORDMINI_STAGING_ALLOWED_UIDS: '  ' }).ok).toBe(false);
    expect(parseStagingAllowlist({ CHORDMINI_STAGING_ALLOWED_UIDS: 'uid-a,,uid-b' }).ok).toBe(false);
  });

  it('rejects an unknown staging mode and a desktop process before verification', async () => {
    const verify = jest.fn();
    const unknown = await gateHostedStagingThenForward('Bearer ' + TOKEN, stagingEnv({
      CHORDMINI_HOSTED_STAGING_AUTH: 'sometimes',
    }), verify);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.body.code).toBe('STAGING_AUTH_NOT_CONFIGURED');
    }

    const desktop = await gateHostedStagingThenForward('Bearer ' + TOKEN, stagingEnv({
      CHORDMINI_DESKTOP_MODE: '1',
    }), verify);
    expect(desktop.ok).toBe(false);
    if (!desktop.ok) {
      expect(desktop.body.code).toBe('INFERENCE_AUTH_NOT_AVAILABLE');
      expect(JSON.stringify(desktop.body)).not.toContain(SECRET);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts only the uid from the injected verifier and still requires the Flask header', async () => {
    const verify = jest.fn(async () => ({ uid: UID }));
    const allowed = await gateHostedStagingThenForward('Bearer ' + TOKEN, stagingEnv(), verify);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.headers[INFERENCE_TOKEN_HEADER]).toBe(SECRET);
    }

    const other = await gateHostedStagingThenForward('Bearer ' + TOKEN, stagingEnv(), async () => ({ uid: 'someone-else' }));
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('USER_NOT_ALLOWLISTED');
    }

    const noFlask = await gateHostedStagingThenForward('Bearer ' + TOKEN, stagingEnv({
      CHORDMINI_INFERENCE_AUTH: 'local',
    }), verify);
    expect(noFlask.ok).toBe(false);
    if (!noFlask.ok) {
      expect(noFlask.body.code).toBe('INFERENCE_AUTH_NOT_CONFIGURED');
    }
  });

  it('leaves the previous forwarder in place when staging is off', async () => {
    const verify = jest.fn();
    const plan = await gateHostedStagingThenForward(null, {
      CHORDMINI_INFERENCE_AUTH: 'required',
      CHORDMINI_INFERENCE_SECRET: SECRET,
    }, verify);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.headers[INFERENCE_TOKEN_HEADER]).toBe(SECRET);
    }
    expect(verify).not.toHaveBeenCalled();
  });
});
