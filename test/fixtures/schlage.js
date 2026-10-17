// -----------------------------------------------------------------------------
// Made-up Schlage answers, shaped like the documents PROTOCOL.md of pyschlage
// describes (a live be489wifi): never a real account. The CAT/SAT tokens, the
// MAC address and the e-mails are there so the tests can check they never
// reach Gladys nor the logs.
// -----------------------------------------------------------------------------

export const EMAIL = 'louis@example.com';
export const PASSWORD = 'pa55 wörd–secret';
/** The Cognito user name (a sub), as USER_ID_FOR_SRP gives it. */
export const USER_ID = '7d9b2f30-1c4e-4a5b-9e8f-0a1b2c3d4e5f';
export const CODE = '246810';
export const NOW = Date.UTC(2026, 9, 17, 8, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const IDS = {
  front: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  back: 'b2c3d4e5f60718293a4b5c6d7e8f90a1',
  sense: 'c3d4e5f60718293a4b5c6d7e8f90a1b2',
};

export const SECRETS = [
  'CAT-SECRET-0001',
  'SAT-SECRET-0001',
  'AA:BB:CC:DD:EE:FF',
  'jean@example.com',
];

const users = [
  { identityId: 'identity-louis', friendlyName: 'Louis', email: EMAIL, role: 'owner' },
  { identityId: 'identity-jean', friendlyName: 'Jean', email: 'jean@example.com', role: 'guest' },
];

export function locks() {
  return [
    {
      deviceId: IDS.front,
      devicetypeId: 'be489wifi',
      name: 'Porte d’entrée',
      modelName: 'BE489WB1 619',
      physicalId: 'phys-1',
      connected: true,
      CAT: 'CAT-SECRET-0001',
      SAT: 'SAT-SECRET-0001',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      users,
      attributes: {
        lockState: 1,
        batteryLevel: 87,
        doorState: 2,
        lockAndLeaveEnabled: 1,
        beeperEnabled: 1,
        autoLockTime: 0,
        macAddress: 'AA:BB:CC:DD:EE:FF',
        lockStateMetadata: { actionType: 'thumbTurn', UUID: null, name: null },
        diagnostics: { churn: 1 },
      },
    },
    {
      deviceId: IDS.back,
      devicetypeId: 'be499wifi2',
      name: 'Back Door',
      modelName: 'BE499WB 619',
      connected: true,
      CAT: 'CAT-SECRET-0002',
      users,
      attributes: {
        lockState: 0,
        batteryLevel: 54,
        doorState: 0,
        lockAndLeaveEnabled: 0,
        lockStateMetadata: { actionType: 'accesscode', UUID: 'code-1', name: 'Jean' },
      },
    },
    {
      deviceId: IDS.sense,
      devicetypeId: 'be479',
      name: 'Garage',
      modelName: 'BE479CAM619',
      connected: true,
      users,
      attributes: { lockState: 1, batteryLevel: 30 },
    },
  ];
}
