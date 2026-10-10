/** Where voice sessions are opened. */
export const RELAY_PATH = '/api/voice/relay';

/** The path and query of one voice session: it works only with the one-use token made for that call. */
export const relayPathFor = (token: string): string => `${RELAY_PATH}?token=${token}`;
