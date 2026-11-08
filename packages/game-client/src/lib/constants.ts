export const MAX_DATAGRAM = 20 * 1024;
export const FRAGMENT_SIZE = 1300;
export const FRAGMENT_BIT = 0x80000000;
export const MAX_MSGLEN_LEGACY = 0x4000;
export const MAX_MSGLEN_118 = 0x20000;
export const PROTOCOL_118 = 118;

export const GENTITYNUM_BITS = 10;
export const ENTITYNUM_NONE = 1023;
export const CLIENTNUM_BITS = 6;
export const MAX_CONFIGSTRINGS = 2048;
export const MAX_STRING_CHARS = 1024;
export const BIG_INFO_STRING = 8192;
export const CS_SERVERINFO = 0;
export const CS_SYSTEMINFO = 1;
export const MAX_HUDELEMS = 31;
export const HUDELEM_BITS = 5;
export const MAX_OBJECTIVES = 16;
/** Objective state is written with this many bits (`OBJST_DONE`). */
export const OBJECTIVE_STATE_BITS = 3;
export const FLOAT_INT_BITS = 13;
export const FLOAT_INT_BIAS = 1 << (FLOAT_INT_BITS - 1);
export const HUDELEM_COORD_BIAS = 1 << 9;

export const SVC_NOP = 0;
export const SVC_GAMESTATE = 1;
export const SVC_CONFIGSTRING = 2;
export const SVC_BASELINE = 3;
export const SVC_SERVER_COMMAND = 4;
export const SVC_DOWNLOAD = 5;
export const SVC_SNAPSHOT = 6;
export const SVC_EOF = 7;

export const CLC_MOVE = 0;
export const CLC_MOVE_NO_DELTA = 1;
export const CLC_CLIENT_COMMAND = 2;
export const CLC_EOF = 3;

export const ET_PLAYER = 1;
export const TEAM_SPECTATOR = 3;
export const MAX_RELIABLE_COMMANDS = 128;
export const SV_ENCODE_START = 4;
export const CLIENT_CLEAR_HEADER = 9;

export function maxMessageLength(protocol: number): number {
  return protocol === PROTOCOL_118 ? MAX_MSGLEN_118 : MAX_MSGLEN_LEGACY;
}

/** 118 writes the fragment offset as a long. Other protocols write a short. */
export function fragmentStartBytes(protocol: number): number {
  return protocol === PROTOCOL_118 ? 4 : 2;
}
